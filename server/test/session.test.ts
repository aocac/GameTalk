/**
 * 同账号多设备的会话规则 + 每设备共享上限的回归测试。
 *
 * 背景：账号是全站共用的，同一账号多端并存曾经派生成片缺陷——共享登记按 userId 唯一
 * （第二台一共享就覆盖第一台、还能把第一台停掉）、REST 退房按 userId 清订阅导致其它端
 * 连坐、乐观消息按房间 FIFO 校正被同账号另一端的广播顶掉。
 * 现在的规则：一台设备（客户端持久化的 deviceId，主窗/采集窗/观看窗共用同一个值）
 * 同时只允许一路共享，且只有最新登录的设备在线。旧客户端不带 deviceId → 归为同一台设备。
 */
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
    const timer = setTimeout(() => {
      ws.onmessage = prev;
      reject(new Error('timeout waiting for ws message'));
    }, 5000);
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

/** 断言在窗口期内不会出现匹配的消息（用于验证「不该广播」） */
function expectNoMessage(ws: WebSocket, predicate: (m: any) => boolean, ms = 400): Promise<void> {
  return new Promise((resolve, reject) => {
    const prev = ws.onmessage;
    const timer = setTimeout(() => {
      ws.onmessage = prev;
      resolve();
    }, ms);
    ws.onmessage = (ev: MessageEvent) => {
      const parsed = JSON.parse(String(ev.data));
      if (predicate(parsed)) {
        clearTimeout(timer);
        ws.onmessage = prev;
        reject(new Error(`unexpected message: ${parsed.type}`));
      }
    };
  });
}

async function connectWs(token: string, deviceId?: string): Promise<WebSocket> {
  const ws = await openClient();
  ws.send(JSON.stringify({ type: 'hello', payload: deviceId ? { token, deviceId } : { token } }));
  await nextMessage(ws, (m) => m.type === 'hello:ok');
  return ws;
}

function closed(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    ws.onclose = () => resolve();
  });
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

describe('单设备登录', () => {
  it('同一设备的多条连接（主窗 + 采集窗）互不顶号', async () => {
    const u = await registerUser('sd_same');
    const ws1 = await connectWs(u.token, 'device-aaaa1111');
    const ws2 = await connectWs(u.token, 'device-aaaa1111');
    // 第二条连接正常拿到 hello:ok 且第一条仍然存活（同一台设备开多个窗口是正常用法）
    expect(ws1.readyState).toBe(WebSocket.OPEN);
    expect(ws2.readyState).toBe(WebSocket.OPEN);
    ws1.close();
    ws2.close();
  });

  it('新设备登录会踢掉旧设备（session_replaced 后关闭）', async () => {
    const u = await registerUser('sd_kick');
    const oldWs = await connectWs(u.token, 'device-old00001');
    const replaced = nextMessage(oldWs, (m) => m.type === 'error' && m.payload?.code === 'session_replaced');
    const oldClosed = closed(oldWs);

    const newWs = await connectWs(u.token, 'device-new00002');

    expect((await replaced).payload.message).toContain('其他设备');
    await oldClosed;
    expect(oldWs.readyState).toBe(WebSocket.CLOSED);
    expect(newWs.readyState).toBe(WebSocket.OPEN);
    newWs.close();
  });

  it('不带 deviceId 的旧客户端之间不互相顶号（向后兼容）', async () => {
    const u = await registerUser('sd_legacy');
    const ws1 = await connectWs(u.token);
    const ws2 = await connectWs(u.token);
    expect(ws1.readyState).toBe(WebSocket.OPEN);
    expect(ws2.readyState).toBe(WebSocket.OPEN);
    ws1.close();
    ws2.close();
  });
});

describe('每设备一路共享', () => {
  it('同一设备在另一个房间再开共享会被拒，且不广播 screen:started', async () => {
    const u = await registerUser('ss_cap');
    const roomA = await createRoom(u.token, '共享上限A');
    const roomB = await createRoom(u.token, '共享上限B');
    const ws = await connectWs(u.token, 'device-cap00001');
    await joinRoomWs(ws, roomA.id);
    await joinRoomWs(ws, roomB.id);

    const startedA = nextMessage(ws, (m) => m.type === 'screen:started');
    ws.send(JSON.stringify({ type: 'screen:start', payload: { roomId: roomA.id } }));
    expect((await startedA).payload.roomId).toBe(roomA.id);

    const err = nextMessage(ws, (m) => m.type === 'error');
    ws.send(JSON.stringify({ type: 'screen:start', payload: { roomId: roomB.id } }));
    const e = await err;
    expect(e.payload.code).toBe('already_sharing');
    // 刻意不复用 roomId 字段：客户端会把它当成「本条消息所属房间」去回滚乐观消息
    expect(e.payload.sharingRoomId).toBe(roomA.id);
    expect(e.payload.roomId).toBeUndefined();

    // 第二个房间不该出现共享开始广播
    await expectNoMessage(ws, (m) => m.type === 'screen:started' && m.payload.roomId === roomB.id);

    // 停止 A 之后，同一设备可以正常在 B 开共享（设备占用已释放）
    const stoppedA = nextMessage(ws, (m) => m.type === 'screen:stopped');
    ws.send(JSON.stringify({ type: 'screen:stop', payload: { roomId: roomA.id } }));
    await stoppedA;

    const startedB = nextMessage(ws, (m) => m.type === 'screen:started' && m.payload.roomId === roomB.id);
    ws.send(JSON.stringify({ type: 'screen:start', payload: { roomId: roomB.id } }));
    expect((await startedB).payload.roomId).toBe(roomB.id);
    ws.close();
  });

  it('同房间重复 screen:start（信令重连重登记）不重复广播', async () => {
    const u = await registerUser('ss_idem');
    const room = await createRoom(u.token, '共享幂等房');
    const ws = await connectWs(u.token, 'device-idem0001');
    await joinRoomWs(ws, room.id);

    const first = nextMessage(ws, (m) => m.type === 'screen:started');
    ws.send(JSON.stringify({ type: 'screen:start', payload: { roomId: room.id } }));
    await first;

    // 重连后重新登记：不能再广播一次（观看端会因此把已有画面重置掉）
    ws.send(JSON.stringify({ type: 'screen:start', payload: { roomId: room.id } }));
    await expectNoMessage(ws, (m) => m.type === 'screen:started');

    ws.close();
  });

  it('不同设备可以各自共享同一个房间', async () => {
    const a = await registerUser('ss_two_a');
    const b = await registerUser('ss_two_b');
    const room = await createRoom(a.token, '双人共享房');
    await app.inject({ method: 'POST', url: '/api/rooms/join', headers: auth(b.token), payload: { inviteCode: room.inviteCode } });

    const wsA = await connectWs(a.token, 'device-two0000a');
    const wsB = await connectWs(b.token, 'device-two0000b');
    await joinRoomWs(wsA, room.id);
    await joinRoomWs(wsB, room.id);

    const seenAtB = nextMessage(wsB, (m) => m.type === 'screen:started' && m.payload.userId === a.userId);
    wsA.send(JSON.stringify({ type: 'screen:start', payload: { roomId: room.id } }));
    await seenAtB;

    const seenAtA = nextMessage(wsA, (m) => m.type === 'screen:started' && m.payload.userId === b.userId);
    wsB.send(JSON.stringify({ type: 'screen:start', payload: { roomId: room.id } }));
    await seenAtA;

    wsA.close();
    wsB.close();
  });
});

describe('退房后的订阅清理', () => {
  it('REST 退房后：不再收到该房间广播，房内成员看到其离线', async () => {
    const owner = await registerUser('lv_owner');
    const member = await registerUser('lv_member');
    const room = await createRoom(owner.token, '退房清理房');
    await app.inject({
      method: 'POST',
      url: '/api/rooms/join',
      headers: auth(member.token),
      payload: { inviteCode: room.inviteCode },
    });

    const wsOwner = await connectWs(owner.token, 'device-lv00000o');
    const wsMember = await connectWs(member.token, 'device-lv00000m');
    await joinRoomWs(wsOwner, room.id);
    await joinRoomWs(wsMember, room.id);

    // 成员走 REST 退房（WS 连接仍在——曾经只清 conn.rooms 不清广播用的 socket 集合，
    // 导致退房后仍能收到该房间全部广播、花名册也还显示在线）
    const left = nextMessage(wsOwner, (m) => m.type === 'member:left' && m.payload.userId === member.userId);
    const res = await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/leave`, headers: auth(member.token) });
    expect(res.statusCode).toBe(200);
    await left;

    // 房主发言，退房者不该再收到
    wsOwner.send(JSON.stringify({ type: 'message:send', payload: { roomId: room.id, text: '退房后不该收到' } }));
    await nextMessage(wsOwner, (m) => m.type === 'message:new');
    await expectNoMessage(wsMember, (m) => m.type === 'message:new');

    // 花名册按 DB 成员表渲染：真正退房后该成员已不在房间，不应再出现（更不该显示在线）
    const joined = nextMessage(wsOwner, (m) => m.type === 'room:joined');
    wsOwner.send(JSON.stringify({ type: 'room:join', payload: { roomId: room.id } }));
    const roster = (await joined).payload.members as Array<{ id: string; online: boolean }>;
    expect(roster.find((m) => m.id === member.userId)).toBeUndefined();

    wsOwner.close();
    wsMember.close();
  });
});
