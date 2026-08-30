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
    const prev = ws.onmessage;
    ws.onmessage = (ev: MessageEvent) => {
      const parsed = JSON.parse(String(ev.data));
      if (!predicate || predicate(parsed)) {
        clearTimeout(timer);
        ws.onmessage = prev;
        resolve(parsed);
      }
    };
  });
}

async function connectWs(token: string): Promise<WebSocket> {
  const ws = await openClient();
  ws.send(JSON.stringify({ type: 'hello', payload: { token } }));
  await nextMessage(ws, (m) => m.type === 'hello:ok');
  return ws;
}

async function joinRoomWs(ws: WebSocket, roomId: string): Promise<void> {
  const got = nextMessage(ws, (m) => m.type === 'room:joined' && m.payload.roomId === roomId);
  ws.send(JSON.stringify({ type: 'room:join', payload: { roomId } }));
  await got;
}

async function createRoom(token: string, name: string): Promise<{ id: string; inviteCode: string }> {
  const res = await app.inject({ method: 'POST', url: '/api/rooms', headers: auth(token), payload: { name } });
  expect(res.statusCode).toBe(201);
  return res.json().room;
}

describe('screen share signaling', () => {
  it('non-members cannot start; start/stop broadcast to room members', async () => {
    const a = await registerUser('scr_a');
    const b = await registerUser('scr_b');
    const outsider = await registerUser('scr_out');
    const room = await createRoom(a.token, '共享房');
    await app.inject({ method: 'POST', url: '/api/rooms/join', headers: auth(b.token), payload: { inviteCode: room.inviteCode } });

    const wsA = await connectWs(a.token);
    const wsB = await connectWs(b.token);
    const wsO = await connectWs(outsider.token);
    await joinRoomWs(wsA, room.id);
    await joinRoomWs(wsB, room.id);

    // 非成员发起 → not_in_room
    const errO = nextMessage(wsO, (m) => m.type === 'error');
    wsO.send(JSON.stringify({ type: 'screen:start', payload: { roomId: room.id } }));
    expect((await errO).payload.code).toBe('not_in_room');

    // 成员发起 → 房间内所有人收到 screen:started（含发起者）
    const gotAtA = nextMessage(wsA, (m) => m.type === 'screen:started');
    const gotAtB = nextMessage(wsB, (m) => m.type === 'screen:started');
    wsA.send(JSON.stringify({ type: 'screen:start', payload: { roomId: room.id } }));
    const evA = await gotAtA;
    const evB = await gotAtB;
    expect(evA.payload).toMatchObject({ roomId: room.id, userId: a.userId, username: 'scr_a' });
    expect(evB.payload).toMatchObject({ userId: a.userId });

    // 停止 → screen:stopped
    const stoppedAtB = nextMessage(wsB, (m) => m.type === 'screen:stopped');
    wsA.send(JSON.stringify({ type: 'screen:stop', payload: { roomId: room.id } }));
    expect((await stoppedAtB).payload).toMatchObject({ roomId: room.id });

    wsA.close();
    wsB.close();
    wsO.close();
  });

  it('forwards WebRTC signaling payload only to the named room member', async () => {
    const a = await registerUser('scr2_a');
    const b = await registerUser('scr2_b');
    const stranger = await registerUser('scr2_stranger');
    const room = await createRoom(a.token, '信令房');
    await app.inject({ method: 'POST', url: '/api/rooms/join', headers: auth(b.token), payload: { inviteCode: room.inviteCode } });

    const wsA = await connectWs(a.token);
    const wsB = await connectWs(b.token);
    await joinRoomWs(wsA, room.id);
    await joinRoomWs(wsB, room.id);

    // 定向转发：SDP 原样透传，服务端不解析
    const signalAtB = nextMessage(wsB, (m) => m.type === 'screen:signal');
    wsA.send(
      JSON.stringify({
        type: 'screen:signal',
        payload: { roomId: room.id, to: b.userId, data: { type: 'offer', sdp: 'v=0-fake-sdp' } },
      }),
    );
    const ev = await signalAtB;
    expect(ev.payload.from).toBe(a.userId);
    expect(ev.payload.data).toEqual({ type: 'offer', sdp: 'v=0-fake-sdp' });

    // 目标非本房间成员 → 拒绝（防把媒体信令发给陌生人）
    const err = nextMessage(wsA, (m) => m.type === 'error');
    wsA.send(
      JSON.stringify({
        type: 'screen:signal',
        payload: { roomId: room.id, to: stranger.userId, data: { type: 'candidate', candidate: {} } },
      }),
    );
    expect((await err).payload.code).toBe('not_in_room');

    wsA.close();
    wsB.close();
  });
});
