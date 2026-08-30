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

async function joinByCode(token: string, inviteCode: string): Promise<void> {
  await app.inject({ method: 'POST', url: '/api/rooms/join', headers: auth(token), payload: { inviteCode } });
}

async function makeFriendPair(prefix: string): Promise<{ a: { token: string; userId: string }; b: { token: string; userId: string } }> {
  const a = await registerUser(`${prefix}_a`);
  const b = await registerUser(`${prefix}_b`);
  await app.inject({ method: 'POST', url: '/api/friends/requests', headers: auth(a.token), payload: { userId: b.userId } });
  await app.inject({ method: 'POST', url: '/api/friends/requests', headers: auth(b.token), payload: { userId: a.userId } });
  return { a, b };
}

function forward(ws: WebSocket, payload: Record<string, unknown>): void {
  ws.send(JSON.stringify({ type: 'message:forward', payload }));
}

async function roomSend(ws: WebSocket, roomId: string, text: string): Promise<string> {
  const got = nextMessage(ws, (m) => m.type === 'message:new' && m.payload.roomId === roomId && m.payload.message.text === text);
  ws.send(JSON.stringify({ type: 'message:send', payload: { roomId, text } }));
  const ev = await got;
  return ev.payload.message.id;
}

describe('message forward', () => {
  it('forwards a room message to another room with source label', async () => {
    const a = await registerUser('fwd_room_a');
    const b = await registerUser('fwd_room_b');
    const src = await createRoom(a.token, '源房');
    await joinByCode(b.token, src.inviteCode);
    const dst = await createRoom(a.token, '目标房');
    await joinByCode(b.token, dst.inviteCode);

    const wsA = await connectWs(a.token);
    const wsB = await connectWs(b.token);
    await joinRoomWs(wsA, src.id);
    await joinRoomWs(wsB, dst.id);

    const msgId = await roomSend(wsA, src.id, '这条会被转发');

    const gotAtB = nextMessage(wsB, (m) => m.type === 'message:new' && m.payload.roomId === dst.id);
    forward(wsA, { source: 'room', messageId: msgId, targetRoomId: dst.id });
    const ev = await gotAtB;
    expect(ev.payload.message).toMatchObject({
      text: '这条会被转发',
      kind: 'text',
      userId: a.userId,
      username: 'fwd_room_a',
      forwardedFromLabel: `来自 源房 · fwd_room_a`,
    });
    expect(ev.payload.message.mentions).toEqual([]);
    wsA.close();
    wsB.close();
  });

  it('denies outsiders of source room, non-members of target, muted users; params validated', async () => {
    const a = await registerUser('fwd_deny_a');
    const b = await registerUser('fwd_deny_b');
    const c = await registerUser('fwd_deny_c');
    const src = await createRoom(a.token, '源房2');
    await joinByCode(b.token, src.inviteCode);
    const dst = await createRoom(b.token, '目标房2');
    await joinByCode(b.token, dst.inviteCode);

    const wsA = await connectWs(a.token);
    const wsC = await connectWs(c.token);
    await joinRoomWs(wsA, src.id);
    const msgId = await roomSend(wsA, src.id, '机密');

    // c 不在源房间 → 不可见
    const errC = nextMessage(wsC, (m) => m.type === 'error');
    forward(wsC, { source: 'room', messageId: msgId, targetRoomId: dst.id });
    expect((await errC).payload.code).toBe('not_in_room');

    // a 不在目标房间 → 拒绝
    const errA = nextMessage(wsA, (m) => m.type === 'error');
    forward(wsA, { source: 'room', messageId: msgId, targetRoomId: dst.id });
    expect((await errA).payload.code).toBe('not_in_room');

    // 参数校验：两个 target / 零 target
    const errBoth = nextMessage(wsA, (m) => m.type === 'error');
    forward(wsA, { source: 'room', messageId: msgId, targetRoomId: src.id, targetUserId: b.userId });
    expect((await errBoth).payload.code).toBe('invalid_input');
    const errNone = nextMessage(wsA, (m) => m.type === 'error');
    forward(wsA, { source: 'room', messageId: msgId });
    expect((await errNone).payload.code).toBe('invalid_input');

    // b 在目标房被房主（b 自己）禁言后转发 → muted（自禁言自测禁言路径：b 是目标房房主，禁言自己被服务端拒绝，
    // 这里改为让 c 成为普通目标：直接用 DB 插禁言）
    await db.query(
      `INSERT INTO room_mutes (room_id, user_id, muted_until) VALUES ($1, $2, now() + interval '10 minutes')
       ON CONFLICT (room_id, user_id) DO UPDATE SET muted_until = excluded.muted_until`,
      [dst.id, b.userId],
    );
    const wsB = await connectWs(b.token);
    await joinRoomWs(wsB, src.id);
    const errMuted = nextMessage(wsB, (m) => m.type === 'error');
    forward(wsB, { source: 'room', messageId: msgId, targetRoomId: dst.id });
    expect((await errMuted).payload.code).toBe('muted');

    // 撤回后的消息不可转发
    const gotRecall = nextMessage(wsA, (m) => m.type === 'message:recalled');
    wsA.send(JSON.stringify({ type: 'message:recall', payload: { roomId: src.id, messageId: msgId } }));
    await gotRecall;
    const errGone = nextMessage(wsA, (m) => m.type === 'error');
    forward(wsA, { source: 'room', messageId: msgId, targetRoomId: src.id });
    expect((await errGone).payload.code).toBe('message_not_found');

    wsA.close();
    wsB.close();
    wsC.close();
  });

  it('forwards between room and dm with correct labels; friendship enforced', async () => {
    const { a, b } = await makeFriendPair('fwd_pair');
    const stranger = await registerUser('fwd_pair_stranger');
    const room = await createRoom(a.token, '跨房');
    await joinByCode(b.token, room.inviteCode);

    const wsA = await connectWs(a.token);
    const wsB = await connectWs(b.token);
    await joinRoomWs(wsA, room.id);
    await joinRoomWs(wsB, room.id);

    // 房间消息 → 私聊给 b
    const msgId = await roomSend(wsA, room.id, '发你一份');
    const gotDmAtB = nextMessage(wsB, (m) => m.type === 'dm:new');
    forward(wsA, { source: 'room', messageId: msgId, targetUserId: b.userId });
    const dmEv = await gotDmAtB;
    expect(dmEv.payload.message).toMatchObject({
      from: a.userId,
      to: b.userId,
      text: '发你一份',
      forwardedFromLabel: `来自 跨房 · fwd_pair_a`,
    });

    // 私聊消息 → 转发回房间（b 转发 a 发来的 dm）
    const dmId = dmEv.payload.message.id as string;
    const gotRoom = nextMessage(wsA, (m) => m.type === 'message:new' && m.payload.roomId === room.id);
    forward(wsB, { source: 'dm', messageId: dmId, targetRoomId: room.id });
    const roomEv = await gotRoom;
    expect(roomEv.payload.message).toMatchObject({
      text: '发你一份',
      userId: b.userId,
      forwardedFromLabel: '来自 fwd_pair_a 的私聊',
    });

    // 非好友不能作为转发目标
    const errNotFriend = nextMessage(wsA, (m) => m.type === 'error');
    forward(wsA, { source: 'room', messageId: msgId, targetUserId: stranger.userId });
    expect((await errNotFriend).payload.code).toBe('not_friends');

    // 无关者不能转发别人的私聊
    const wsS = await connectWs(stranger.token);
    const errS = nextMessage(wsS, (m) => m.type === 'error');
    forward(wsS, { source: 'dm', messageId: dmId, targetRoomId: room.id });
    expect((await errS).payload.code).toBe('not_in_room');

    wsA.close();
    wsB.close();
    wsS.close();
  });

  it('forwards image messages with media reference intact', async () => {
    const a = await registerUser('fwd_img_a');
    const b = await registerUser('fwd_img_b');
    const src = await createRoom(a.token, '图源房');
    await joinByCode(b.token, src.inviteCode);
    const dst = await createRoom(a.token, '图标房');
    await joinByCode(b.token, dst.inviteCode);

    const png =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const mediaId = (
      await app.inject({ method: 'POST', url: '/api/media', headers: auth(a.token), payload: { dataUrl: png } })
    ).json().id as string;
    const mediaUrl = `/api/media/${mediaId}`;

    const wsA = await connectWs(a.token);
    const wsB = await connectWs(b.token);
    await joinRoomWs(wsA, src.id);
    await joinRoomWs(wsB, dst.id);

    const gotSent = nextMessage(wsA, (m) => m.type === 'message:new' && m.payload.roomId === src.id);
    wsA.send(JSON.stringify({ type: 'message:send', payload: { roomId: src.id, text: '', mediaUrl } }));
    const sent = await gotSent;

    const gotAtB = nextMessage(wsB, (m) => m.type === 'message:new' && m.payload.roomId === dst.id);
    forward(wsA, { source: 'room', messageId: sent.payload.message.id, targetRoomId: dst.id });
    const ev = await gotAtB;
    expect(ev.payload.message.kind).toBe('image');
    expect(ev.payload.message.mediaUrl).toContain(mediaId);

    wsA.close();
    wsB.close();
  });
});
