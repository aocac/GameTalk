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

async function registerUser(username: string): Promise<{ token: string; userId: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username, password: 'password123' },
  });
  const body = res.json();
  return { token: body.token, userId: body.user.id };
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
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

async function connectWs(token: string): Promise<WebSocket> {
  const ws = await openClient();
  ws.send(JSON.stringify({ type: 'hello', payload: { token } }));
  await nextMessage(ws, (m) => m.type === 'hello:ok');
  return ws;
}

describe('rooms REST', () => {
  it('creates a room with invite code and auto-joins owner', async () => {
    const { token } = await registerUser('room_owner');
    const res = await app.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: auth(token),
      payload: { name: '开黑小队' },
    });
    expect(res.statusCode).toBe(201);
    const { room } = res.json();
    expect(room.name).toBe('开黑小队');
    expect(room.inviteCode).toMatch(/^[A-Z2-9]{8}$/);
    expect(room.memberCount).toBe(1);
    expect(room.ownerId).toBeTruthy();
  });

  it('rejects empty room name', async () => {
    const { token } = await registerUser('room_badname');
    const res = await app.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: auth(token),
      payload: { name: '   ' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('lists my rooms', async () => {
    const { token } = await registerUser('room_lister');
    await app.inject({ method: 'POST', url: '/api/rooms', headers: auth(token), payload: { name: 'R1' } });
    const res = await app.inject({ method: 'GET', url: '/api/rooms', headers: auth(token) });
    expect(res.statusCode).toBe(200);
    const { rooms } = res.json();
    expect(rooms.length).toBe(1);
    expect(rooms[0].name).toBe('R1');
  });

  it('joins a room via invite code', async () => {
    const owner = await registerUser('join_owner');
    const { room } = (
      await app.inject({ method: 'POST', url: '/api/rooms', headers: auth(owner.token), payload: { name: 'Squad' } })
    ).json();

    const member = await registerUser('join_member');
    const res = await app.inject({
      method: 'POST',
      url: '/api/rooms/join',
      headers: auth(member.token),
      payload: { inviteCode: room.inviteCode },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().room.id).toBe(room.id);
    expect(res.json().room.memberCount).toBe(2);

    // 邀请码错误
    const res2 = await app.inject({
      method: 'POST',
      url: '/api/rooms/join',
      headers: auth(member.token),
      payload: { inviteCode: 'ZZZZZZZZ' },
    });
    expect(res2.statusCode).toBe(404);
  });

  it('room detail shows members; non-member is forbidden', async () => {
    const owner = await registerUser('detail_owner');
    const { room } = (
      await app.inject({ method: 'POST', url: '/api/rooms', headers: auth(owner.token), payload: { name: 'Detail' } })
    ).json();

    const res = await app.inject({ method: 'GET', url: `/api/rooms/${room.id}`, headers: auth(owner.token) });
    expect(res.statusCode).toBe(200);
    expect(res.json().members.map((m: any) => m.username)).toContain('detail_owner');

    const outsider = await registerUser('detail_outside');
    const res2 = await app.inject({ method: 'GET', url: `/api/rooms/${room.id}`, headers: auth(outsider.token) });
    expect(res2.statusCode).toBe(403);
  });

  it('leaves a room; empty room is deleted', async () => {
    const owner = await registerUser('leave_owner');
    const { room } = (
      await app.inject({ method: 'POST', url: '/api/rooms', headers: auth(owner.token), payload: { name: 'Temp' } })
    ).json();

    const res = await app.inject({
      method: 'POST',
      url: `/api/rooms/${room.id}/leave`,
      headers: auth(owner.token),
    });
    expect(res.statusCode).toBe(200);

    // 空房间已删除
    const res2 = await app.inject({ method: 'GET', url: `/api/rooms/${room.id}`, headers: auth(owner.token) });
    expect(res2.statusCode).toBe(404);
  });
});

describe('realtime + persistence', () => {
  it('persists messages and paginates history', async () => {
    const owner = await registerUser('hist_owner');
    const { room } = (
      await app.inject({ method: 'POST', url: '/api/rooms', headers: auth(owner.token), payload: { name: 'Hist' } })
    ).json();

    const ws = await connectWs(owner.token);
    ws.send(JSON.stringify({ type: 'room:join', payload: { roomId: room.id } }));
    await nextMessage(ws, (m) => m.type === 'room:joined');

    // 发 3 条
    for (let i = 1; i <= 3; i++) {
      const got = nextMessage(ws, (m) => m.type === 'message:new');
      ws.send(JSON.stringify({ type: 'message:send', payload: { roomId: room.id, text: `msg-${i}` } }));
      await got;
    }

    // 历史拉取
    const res = await app.inject({ method: 'GET', url: `/api/rooms/${room.id}/messages`, headers: auth(owner.token) });
    expect(res.statusCode).toBe(200);
    const { messages } = res.json();
    expect(messages.map((m: any) => m.text)).toEqual(['msg-1', 'msg-2', 'msg-3']);
    expect(messages[0].username).toBe('hist_owner');
    ws.close();
  });

  it('non-member cannot subscribe to room via WS', async () => {
    const owner = await registerUser('sub_owner');
    const { room } = (
      await app.inject({ method: 'POST', url: '/api/rooms', headers: auth(owner.token), payload: { name: 'Sub' } })
    ).json();

    const outsider = await registerUser('sub_outside');
    const ws = await connectWs(outsider.token);
    const errPromise = nextMessage(ws, (m) => m.type === 'error');
    ws.send(JSON.stringify({ type: 'room:join', payload: { roomId: room.id } }));
    expect((await errPromise).payload.code).toBe('not_in_room');
    ws.close();
  });

  it('member:joined/left broadcasts across rooms', async () => {
    const owner = await registerUser('pres_owner');
    const { room } = (
      await app.inject({ method: 'POST', url: '/api/rooms', headers: auth(owner.token), payload: { name: 'Pres' } })
    ).json();

    const member = await registerUser('pres_member');
    // member 先通过邀请码加入房间
    await app.inject({
      method: 'POST',
      url: '/api/rooms/join',
      headers: auth(member.token),
      payload: { inviteCode: room.inviteCode },
    });

    const wsO = await connectWs(owner.token);
    const wsM = await connectWs(member.token);
    wsO.send(JSON.stringify({ type: 'room:join', payload: { roomId: room.id } }));
    await nextMessage(wsO, (m) => m.type === 'room:joined');

    const oSeesM = nextMessage(wsO, (m) => m.type === 'member:joined');
    wsM.send(JSON.stringify({ type: 'room:join', payload: { roomId: room.id } }));
    await nextMessage(wsM, (m) => m.type === 'room:joined');
    expect((await oSeesM).payload.member.username).toBe('pres_member');

    const oSeesLeft = nextMessage(wsO, (m) => m.type === 'member:left');
    wsM.close();
    expect((await oSeesLeft).payload.userId).toBe(member.userId);
    wsO.close();
  });
});
