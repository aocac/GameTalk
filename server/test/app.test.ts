import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createDb, type Db } from '../src/db/db.js';
import { runMigrations } from '../src/db/migrate.js';
import { loadConfig } from '../src/config.js';
import { createJwtService } from '../src/lib/jwt.js';

let app: FastifyInstance;
let db: Db;
let wsUrl = '';

async function registerUser(username: string, password = 'password123'): Promise<{ token: string; userId: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username, password },
  });
  const body = res.json();
  return { token: body.token, userId: body.user.id };
}

beforeAll(async () => {
  db = createDb(loadConfig({ NODE_ENV: 'test' }));
  await runMigrations(db);
  const jwt = createJwtService('test-secret', '1h');
  app = await buildApp({ config: loadConfig({ NODE_ENV: 'test' }), db, jwt });
  await app.listen({ host: '127.0.0.1', port: 0 });
  wsUrl = `ws://127.0.0.1:${(app.server.address() as { port: number }).port}/ws`;
});

afterAll(async () => {
  await app.close();
  await db.close();
});

/**
 * 注意：Node 22 undici WebSocket 的 addEventListener('message') 不触发，
 * 必须使用 onmessage。这里用「队列式监听器 + 单 onmessage 派发」模拟多监听语义。
 */
const listeners = new WeakMap<WebSocket, Set<(ev: MessageEvent) => void>>();

function onMsg(ws: WebSocket, fn: (ev: MessageEvent) => void): void {
  let set = listeners.get(ws);
  if (!set) {
    set = new Set();
    listeners.set(ws, set);
    ws.onmessage = (ev) => {
      for (const cb of [...set]) cb(ev);
    };
  }
  set.add(fn);
}

function offMsg(ws: WebSocket, fn: (ev: MessageEvent) => void): void {
  listeners.get(ws)?.delete(fn);
}

function openClient(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error('ws connect failed'));
  });
}

function nextMessage(ws: WebSocket, predicate?: (m: any) => boolean): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for ws message')), 5000);
    const onEv = (ev: MessageEvent) => {
      const parsed = JSON.parse(String(ev.data));
      if (!predicate || predicate(parsed)) {
        clearTimeout(timer);
        offMsg(ws, onEv);
        resolve(parsed);
      }
    };
    onMsg(ws, onEv);
  });
}

describe('health', () => {
  it('GET /health returns ok with db check', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
  });
});

describe('realtime chat loop (two authenticated clients, one room)', () => {
  /** 创建房间并把两个用户都加为成员（owner + invite join） */
  async function makeRoomForTwo(tokenA: string, tokenB: string): Promise<string> {
    const created = await app.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { name: 'Squad Room' },
    });
    const roomId = created.json().room.id;
    const inviteCode = created.json().room.inviteCode;
    await app.inject({
      method: 'POST',
      url: '/api/rooms/join',
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { inviteCode },
    });
    return roomId;
  }

  it('A and B join room, A sends message, B receives it', async () => {
    const { token: tokenA } = await registerUser('alice_ws');
    const { token: tokenB } = await registerUser('bob_ws');
    const roomId = await makeRoomForTwo(tokenA, tokenB);
    const a = await openClient();
    const b = await openClient();

    a.send(JSON.stringify({ type: 'hello', payload: { token: tokenA } }));
    b.send(JSON.stringify({ type: 'hello', payload: { token: tokenB } }));
    const helloA = await nextMessage(a, (m) => m.type === 'hello:ok');
    const helloB = await nextMessage(b, (m) => m.type === 'hello:ok');
    expect(helloA.payload.me.username).toBe('alice_ws');
    expect(helloB.payload.me.username).toBe('bob_ws');

    // 双方入房
    a.send(JSON.stringify({ type: 'room:join', payload: { roomId } }));
    await nextMessage(a, (m) => m.type === 'room:joined' && m.payload.roomId === roomId);
    const aSeesB = nextMessage(a, (m) => m.type === 'member:joined' && m.payload.member.username === 'bob_ws');
    b.send(JSON.stringify({ type: 'room:join', payload: { roomId } }));
    const bJoined = await nextMessage(b, (m) => m.type === 'room:joined' && m.payload.roomId === roomId);
    expect(bJoined.payload.members.map((x: any) => x.username)).toContain('alice_ws');
    await aSeesB;

    // A 发消息，B 收到
    const bMsgPromise = nextMessage(b, (m) => m.type === 'message:new');
    a.send(JSON.stringify({ type: 'message:send', payload: { roomId, text: 'Hello GameTalk!' } }));
    const bMsg = await bMsgPromise;
    expect(bMsg.payload.message.text).toBe('Hello GameTalk!');
    expect(bMsg.payload.message.username).toBe('alice_ws');
    expect(bMsg.payload.message.id).toBeTruthy();
    expect(bMsg.payload.message.createdAt).toBeTruthy();

    a.close();
    b.close();
  });

  it('rejects empty messages, truncates long ones, rejects send when not in room', async () => {
    const { token } = await registerUser('tester_ws');
    const created = await app.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Test Room' },
    });
    const roomId = created.json().room.id;
    const a = await openClient();
    a.send(JSON.stringify({ type: 'hello', payload: { token } }));
    await nextMessage(a, (m) => m.type === 'hello:ok');
    a.send(JSON.stringify({ type: 'room:join', payload: { roomId } }));
    await nextMessage(a, (m) => m.type === 'room:joined');

    const err1 = nextMessage(a, (m) => m.type === 'error');
    a.send(JSON.stringify({ type: 'message:send', payload: { roomId, text: '   ' } }));
    expect((await err1).payload.code).toBe('empty_message');

    const longMsgPromise = nextMessage(a, (m) => m.type === 'message:new');
    a.send(JSON.stringify({ type: 'message:send', payload: { roomId, text: 'x'.repeat(3000) } }));
    expect((await longMsgPromise).payload.message.text.length).toBe(2000);

    a.send(JSON.stringify({ type: 'room:leave', payload: { roomId } }));
    const err2 = nextMessage(a, (m) => m.type === 'error');
    a.send(JSON.stringify({ type: 'message:send', payload: { roomId, text: 'hi' } }));
    expect((await err2).payload.code).toBe('not_in_room');

    a.close();
  });

  it('rejects ws hello with invalid token and closes', async () => {
    const a = await openClient();
    const errPromise = nextMessage(a, (m) => m.type === 'error');
    a.send(JSON.stringify({ type: 'hello', payload: { token: 'not-a-valid-token' } }));
    const err = await errPromise;
    expect(err.payload.code).toBe('unauthorized');
    a.close();
  });

  it('broadcasts member:left when a client disconnects', async () => {
    const { token: tokenA, userId: uidA } = await registerUser('alice_leave');
    const { token: tokenB } = await registerUser('bob_leave');
    const roomId = await makeRoomForTwo(tokenA, tokenB);
    const a = await openClient();
    const b = await openClient();
    a.send(JSON.stringify({ type: 'hello', payload: { token: tokenA } }));
    b.send(JSON.stringify({ type: 'hello', payload: { token: tokenB } }));
    await nextMessage(a, (m) => m.type === 'hello:ok');
    await nextMessage(b, (m) => m.type === 'hello:ok');

    a.send(JSON.stringify({ type: 'room:join', payload: { roomId } }));
    await nextMessage(a, (m) => m.type === 'room:joined');
    b.send(JSON.stringify({ type: 'room:join', payload: { roomId } }));
    await nextMessage(b, (m) => m.type === 'room:joined');

    const bLeftPromise = nextMessage(b, (m) => m.type === 'member:left' && m.payload.userId === uidA);
    a.close();
    const bLeft = await bLeftPromise;
    expect(bLeft.payload.roomId).toBe(roomId);
    b.close();
  });
});
