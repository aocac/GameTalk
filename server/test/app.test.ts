import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createDb, type Db } from '../src/db/db.js';
import { runMigrations } from '../src/db/migrate.js';
import { loadConfig } from '../src/config.js';

let app: FastifyInstance;
let db: Db;
let wsUrl = '';

beforeAll(async () => {
  db = createDb(loadConfig({ NODE_ENV: 'test' }));
  await runMigrations(db);
  app = await buildApp({ config: loadConfig({ NODE_ENV: 'test' }), db });
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

describe('realtime chat loop (two clients, one room)', () => {
  it('A and B join room, A sends message, B receives it', async () => {
    const a = await openClient();
    const b = await openClient();

    a.send(JSON.stringify({ type: 'hello', payload: { name: 'Alice' } }));
    b.send(JSON.stringify({ type: 'hello', payload: { name: 'Bob' } }));
    await nextMessage(a, (m) => m.type === 'hello:ok');
    await nextMessage(b, (m) => m.type === 'hello:ok');

    // 双方都加入 lobby
    a.send(JSON.stringify({ type: 'room:join', payload: { roomId: 'lobby' } }));
    await nextMessage(a, (m) => m.type === 'room:joined' && m.payload.roomId === 'lobby');
    b.send(JSON.stringify({ type: 'room:join', payload: { roomId: 'lobby' } }));
    const bJoined = await nextMessage(b, (m) => m.type === 'room:joined' && m.payload.roomId === 'lobby');
    expect(bJoined.payload.members.map((x: any) => x.username)).toContain('Alice');

    // A 发消息，B 收到
    const bMsgPromise = nextMessage(b, (m) => m.type === 'message:new');
    a.send(JSON.stringify({ type: 'message:send', payload: { roomId: 'lobby', text: 'Hello GameTalk!' } }));
    const bMsg = await bMsgPromise;
    expect(bMsg.payload.message.text).toBe('Hello GameTalk!');
    expect(bMsg.payload.message.username).toBe('Alice');
    expect(bMsg.payload.message.id).toBeTruthy();
    expect(bMsg.payload.message.createdAt).toBeTruthy();

    a.close();
    b.close();
  });

  it('rejects empty messages, truncates long ones, rejects send when not in room', async () => {
    const a = await openClient();
    a.send(JSON.stringify({ type: 'hello', payload: { name: 'Tester' } }));
    await nextMessage(a, (m) => m.type === 'hello:ok');
    a.send(JSON.stringify({ type: 'room:join', payload: { roomId: 'lobby' } }));
    await nextMessage(a, (m) => m.type === 'room:joined');

    const err1 = nextMessage(a, (m) => m.type === 'error');
    a.send(JSON.stringify({ type: 'message:send', payload: { roomId: 'lobby', text: '   ' } }));
    expect((await err1).payload.code).toBe('empty_message');

    // 超长消息被截断为 2000 字符
    const longMsgPromise = nextMessage(a, (m) => m.type === 'message:new');
    a.send(JSON.stringify({ type: 'message:send', payload: { roomId: 'lobby', text: 'x'.repeat(3000) } }));
    const longMsg = await longMsgPromise;
    expect(longMsg.payload.message.text.length).toBe(2000);

    // 离开房间后发消息被拒（member:left 广播给其他成员，离开者自身不收）
    a.send(JSON.stringify({ type: 'room:leave', payload: { roomId: 'lobby' } }));
    const err2 = nextMessage(a, (m) => m.type === 'error');
    a.send(JSON.stringify({ type: 'message:send', payload: { roomId: 'lobby', text: 'hi' } }));
    expect((await err2).payload.code).toBe('not_in_room');

    a.close();
  });

  it('broadcasts member:left when a client disconnects', async () => {
    const a = await openClient();
    const b = await openClient();
    a.send(JSON.stringify({ type: 'hello', payload: { name: 'Alice' } }));
    b.send(JSON.stringify({ type: 'hello', payload: { name: 'Bob' } }));
    const helloA = await nextMessage(a, (m) => m.type === 'hello:ok');
    const aUserId = helloA.payload.me.id;
    await nextMessage(b, (m) => m.type === 'hello:ok');

    a.send(JSON.stringify({ type: 'room:join', payload: { roomId: 'lobby' } }));
    await nextMessage(a, (m) => m.type === 'room:joined');
    b.send(JSON.stringify({ type: 'room:join', payload: { roomId: 'lobby' } }));
    await nextMessage(b, (m) => m.type === 'room:joined');

    const bLeftPromise = nextMessage(b, (m) => m.type === 'member:left' && m.payload.userId === aUserId);
    a.close();
    const bLeft = await bLeftPromise;
    expect(bLeft.payload.roomId).toBe('lobby');
    b.close();
  });
});
