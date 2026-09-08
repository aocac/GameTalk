import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, isTrustedProxy } from '../src/app.js';
import { createDb, type Db } from '../src/db/db.js';
import { runMigrations } from '../src/db/migrate.js';
import { loadConfig } from '../src/config.js';
import { createJwtService } from '../src/lib/jwt.js';

/**
 * 2026-09-09 全量核查修复的回归测试。
 * 每个用例对应一个已确认缺陷，注释里写明修复前的错误行为。
 */

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

async function createRoom(token: string, name: string): Promise<{ id: string; inviteCode: string }> {
  const res = await app.inject({ method: 'POST', url: '/api/rooms', headers: auth(token), payload: { name } });
  return res.json().room;
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

function nextMessage(ws: WebSocket, predicate?: (m: any) => boolean): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for ws message')), 8000);
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
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('ws connect failed'));
  });
  ws.send(JSON.stringify({ type: 'hello', payload: { token } }));
  await nextMessage(ws, (m) => m.type === 'hello:ok');
  return ws;
}

async function joinWs(ws: WebSocket, roomId: string): Promise<void> {
  ws.send(JSON.stringify({ type: 'room:join', payload: { roomId } }));
  await nextMessage(ws, (m) => m.type === 'room:joined' && m.payload.roomId === roomId);
}

function sendWs(ws: WebSocket, type: string, payload: Record<string, unknown>): void {
  ws.send(JSON.stringify({ type, payload }));
}

describe('历史分页（修复：每页丢弃最新一条消息）', () => {
  it('房间历史：limit+2 条消息时首屏含最新一条，翻页不漏不重', async () => {
    const owner = await registerUser('reg_page_owner');
    const room = await createRoom(owner.token, '分页房');
    const ws = await connectWs(owner.token);
    await joinWs(ws, room.id);

    const ids: string[] = [];
    for (let i = 1; i <= 5; i++) {
      const incoming = nextMessage(ws, (m) => m.type === 'message:new');
      sendWs(ws, 'message:send', { roomId: room.id, text: `m${i}` });
      ids.push((await incoming).payload.message.id);
    }

    // 第一页 limit=2：修复前返回 [m3,m4] 丢掉 m5
    const p1 = await app.inject({
      method: 'GET',
      url: `/api/rooms/${room.id}/messages?limit=2`,
      headers: auth(owner.token),
    });
    const page1 = p1.json();
    expect(page1.messages.map((m: any) => m.text)).toEqual(['m4', 'm5']);
    expect(page1.hasMore).toBe(true);

    // 以最旧一条为游标翻页：修复前 m5 永远拿不到
    const oldest1 = page1.messages[0].id;
    const p2 = await app.inject({
      method: 'GET',
      url: `/api/rooms/${room.id}/messages?limit=2&before=${oldest1}`,
      headers: auth(owner.token),
    });
    const page2 = p2.json();
    expect(page2.messages.map((m: any) => m.text)).toEqual(['m2', 'm3']);

    const oldest2 = page2.messages[0].id;
    const p3 = await app.inject({
      method: 'GET',
      url: `/api/rooms/${room.id}/messages?limit=2&before=${oldest2}`,
      headers: auth(owner.token),
    });
    const page3 = p3.json();
    expect(page3.messages.map((m: any) => m.text)).toEqual(['m1']);
    expect(page3.hasMore).toBe(false);

    // 全量拼接 = 5 条，无丢失无重复
    const all = [...page3.messages, ...page2.messages, ...page1.messages].map((m: any) => m.text);
    expect(all).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
    expect(new Set(ids).size).toBe(5);
    ws.close();
  });

  it('非法游标 / 非法房间 id 返回 400 而不是 500', async () => {
    const u = await registerUser('reg_page_bad');
    const bad = await app.inject({
      method: 'GET',
      url: '/api/rooms/not-a-uuid/messages',
      headers: auth(u.token),
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('invalid_input');

    const room = await createRoom(u.token, '游标房');
    const badCursor = await app.inject({
      method: 'GET',
      url: `/api/rooms/${room.id}/messages?before=not-a-uuid`,
      headers: auth(u.token),
    });
    expect(badCursor.statusCode).toBe(400);
  });
});

describe('空消息守卫（修复：mediaUrls: [] 绕过）', () => {
  it('mediaUrls 为空数组不算内容 → empty_message', async () => {
    const owner = await registerUser('reg_empty_owner');
    const room = await createRoom(owner.token, '空消息房');
    const ws = await connectWs(owner.token);
    await joinWs(ws, room.id);

    const err = nextMessage(ws, (m) => m.type === 'error');
    sendWs(ws, 'message:send', { roomId: room.id, text: '', mediaUrls: [] });
    expect((await err).payload.code).toBe('empty_message');

    // 确认没有落库空消息
    const hist = await app.inject({ method: 'GET', url: `/api/rooms/${room.id}/messages`, headers: auth(owner.token) });
    expect(hist.json().messages).toEqual([]);
    ws.close();
  });
});

describe('退房/删房后的实时订阅（修复：旧连接仍可发送）', () => {
  it('REST 退房后同一连接发送被拒（not_in_room）', async () => {
    const owner = await registerUser('reg_leave_owner');
    const member = await registerUser('reg_leave_member');
    const room = await createRoom(owner.token, '退房房');
    await app.inject({ method: 'POST', url: '/api/rooms/join', headers: auth(member.token), payload: { inviteCode: room.inviteCode } });

    const ws = await connectWs(member.token);
    await joinWs(ws, room.id);

    const left = await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/leave`, headers: auth(member.token) });
    expect(left.statusCode).toBe(200);

    const err = nextMessage(ws, (m) => m.type === 'error');
    sendWs(ws, 'message:send', { roomId: room.id, text: '退房后还能发吗' });
    expect((await err).payload.code).toBe('not_in_room');
    ws.close();
  });

  it('房主不能退房（避免房间失去管理权），成员退房后房间保留', async () => {
    const owner = await registerUser('reg_ownerleave');
    const room = await createRoom(owner.token, '房主退房房');
    const res = await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/leave`, headers: auth(owner.token) });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('owner_cannot_leave');
  });

  it('删房后成员发送被拒（not_in_room 而非 internal_error）', async () => {
    const owner = await registerUser('reg_del_owner');
    const member = await registerUser('reg_del_member');
    const room = await createRoom(owner.token, '删房房');
    await app.inject({ method: 'POST', url: '/api/rooms/join', headers: auth(member.token), payload: { inviteCode: room.inviteCode } });

    const wsOwner = await connectWs(owner.token);
    await joinWs(wsOwner, room.id);
    const wsMember = await connectWs(member.token);
    await joinWs(wsMember, room.id);

    const deleted = nextMessage(wsMember, (m) => m.type === 'room:deleted');
    sendWs(wsOwner, 'room:delete', { roomId: room.id });
    await deleted;

    const err = nextMessage(wsMember, (m) => m.type === 'error');
    sendWs(wsMember, 'message:send', { roomId: room.id, text: '删房后还能发吗' });
    expect((await err).payload.code).toBe('not_in_room');
    wsOwner.close();
    wsMember.close();
  });
});

describe('目标不在房间的错误码（修复：误让调用方丢房）', () => {
  it('踢一个已不在房间的成员 → target_not_in_room', async () => {
    const owner = await registerUser('reg_kick_owner');
    const member = await registerUser('reg_kick_member');
    const room = await createRoom(owner.token, '踢人房');
    await app.inject({ method: 'POST', url: '/api/rooms/join', headers: auth(member.token), payload: { inviteCode: room.inviteCode } });
    // 成员先自己退房（DB 已无记录，但房主端内存花名册可能还留着）
    await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/leave`, headers: auth(member.token) });

    const ws = await connectWs(owner.token);
    await joinWs(ws, room.id);
    const err = nextMessage(ws, (m) => m.type === 'error');
    sendWs(ws, 'member:kick', { roomId: room.id, userId: member.userId });
    const payload = (await err).payload;
    expect(payload.code).toBe('target_not_in_room');
    expect(payload.roomId).toBe(room.id);
    ws.close();
  });

  it('信令目标不在房间 → target_not_in_room', async () => {
    const owner = await registerUser('reg_sig_owner');
    const room = await createRoom(owner.token, '信令房');
    const ws = await connectWs(owner.token);
    await joinWs(ws, room.id);
    const err = nextMessage(ws, (m) => m.type === 'error');
    sendWs(ws, 'screen:signal', { roomId: room.id, to: '00000000-0000-4000-8000-000000000000', data: { type: 'request', cid: 'x' } });
    expect((await err).payload.code).toBe('target_not_in_room');
    ws.close();
  });
});

describe('私聊撤回（修复：media_urls 未清空）', () => {
  it('撤回多图私聊后历史不再返回图片', async () => {
    const a = await registerUser('reg_dmrecall_a');
    const b = await registerUser('reg_dmrecall_b');
    await app.inject({ method: 'POST', url: '/api/friends/requests', headers: auth(a.token), payload: { userId: b.userId } });
    const reqId = (await app.inject({ method: 'GET', url: '/api/friends/requests', headers: auth(b.token) })).json().incoming[0].id;
    await app.inject({ method: 'POST', url: `/api/friends/requests/${reqId}/accept`, headers: auth(b.token) });

    const media = await app.inject({
      method: 'POST',
      url: '/api/media',
      headers: auth(a.token),
      payload: { dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==' },
    });
    const mediaId = media.json().id as string;
    const ws = await connectWs(a.token);
    const incoming = nextMessage(ws, (m) => m.type === 'dm:new');
    sendWs(ws, 'dm:send', { to: b.userId, text: '', mediaUrls: [`/api/media/${mediaId}`] });
    const msg = (await incoming).payload.message;

    const recalled = nextMessage(ws, (m) => m.type === 'dm:recalled');
    sendWs(ws, 'dm:recall', { messageId: msg.id });
    await recalled;

    const hist = await app.inject({ method: 'GET', url: `/api/dm/${b.userId}/messages`, headers: auth(a.token) });
    const row = hist.json().messages.find((m: any) => m.id === msg.id);
    expect(row.recalled).toBe(true);
    expect(row.mediaUrl).toBeNull();
    expect(row.mediaUrls ?? null).toBeNull();
    ws.close();
  });
});

describe('编辑重算提及（修复：编辑后 @ 不生效）', () => {
  it('编辑时新增 @成员 会写入 mentions 并随广播下发', async () => {
    const owner = await registerUser('reg_edit_owner');
    const target = await registerUser('reg_edit_target');
    const room = await createRoom(owner.token, '编辑提及房');
    await app.inject({ method: 'POST', url: '/api/rooms/join', headers: auth(target.token), payload: { inviteCode: room.inviteCode } });

    const ws = await connectWs(owner.token);
    await joinWs(ws, room.id);
    const created = nextMessage(ws, (m) => m.type === 'message:new');
    sendWs(ws, 'message:send', { roomId: room.id, text: 'hello' });
    const msg = (await created).payload.message;
    expect(msg.mentions).toEqual([]);

    const edited = nextMessage(ws, (m) => m.type === 'message:edited');
    sendWs(ws, 'message:edit', { roomId: room.id, messageId: msg.id, text: 'hello @reg_edit_target' });
    const payload = (await edited).payload;
    expect(payload.mentions.map((m: any) => m.id)).toEqual([target.userId]);

    const hist = await app.inject({ method: 'GET', url: `/api/rooms/${room.id}/messages`, headers: auth(owner.token) });
    expect(hist.json().messages[0].mentions.map((m: any) => m.id)).toEqual([target.userId]);
    ws.close();
  });
});

describe('改名后广播用户名（修复：conn 快照不更新）', () => {
  it('改名后发送的消息使用新用户名', async () => {
    const owner = await registerUser('reg_rename_old');
    const room = await createRoom(owner.token, '改名房');
    const ws = await connectWs(owner.token);
    await joinWs(ws, room.id);

    const renamed = await app.inject({
      method: 'PATCH',
      url: '/api/auth/me',
      headers: auth(owner.token),
      payload: { username: 'reg_rename_new' },
    });
    expect(renamed.statusCode).toBe(200);

    const created = nextMessage(ws, (m) => m.type === 'message:new');
    sendWs(ws, 'message:send', { roomId: room.id, text: '改名后' });
    expect((await created).payload.message.username).toBe('reg_rename_new');
    ws.close();
  });
});

describe('群表情媒体归属（修复：可登记任意媒体）', () => {
  it('不能把他人媒体加入群表情库，也不接受不存在的媒体 id', async () => {
    const owner = await registerUser('reg_stk_owner');
    const member = await registerUser('reg_stk_member');
    const room = await createRoom(owner.token, '表情房');
    await app.inject({ method: 'POST', url: '/api/rooms/join', headers: auth(member.token), payload: { inviteCode: room.inviteCode } });

    const media = await app.inject({
      method: 'POST',
      url: '/api/media',
      headers: auth(owner.token),
      payload: { dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==' },
    });
    const mediaId = media.json().id as string;

    // 他人媒体 → 403（修复前 201，之后可借群表情绕过归属校验发出去）
    const foreign = await app.inject({
      method: 'POST',
      url: `/api/rooms/${room.id}/stickers`,
      headers: auth(member.token),
      payload: { mediaId },
    });
    expect(foreign.statusCode).toBe(403);

    // 不存在的媒体 → 404（修复前 FK 23503 → 500）
    const missing = await app.inject({
      method: 'POST',
      url: `/api/rooms/${room.id}/stickers`,
      headers: auth(member.token),
      payload: { mediaId: '00000000-0000-4000-8000-000000000000' },
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe('邀请兑换并发（修复：可超额使用 / 并发 500）', () => {
  it('maxUses=1 的链接被两人同时兑换：恰好一人成功，计数为 1', async () => {
    const owner = await registerUser('reg_inv_owner');
    const u1 = await registerUser('reg_inv_1');
    const u2 = await registerUser('reg_inv_2');
    const room = await createRoom(owner.token, '并发邀请房');
    const code = (
      await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/invites`, headers: auth(owner.token), payload: { maxUses: 1 } })
    ).json().invite.code;

    const [r1, r2] = await Promise.all([
      app.inject({ method: 'POST', url: `/api/invites/${code}/redeem`, headers: auth(u1.token) }),
      app.inject({ method: 'POST', url: `/api/invites/${code}/redeem`, headers: auth(u2.token) }),
    ]);
    const codes = [r1.statusCode, r2.statusCode].sort();
    expect(codes).toEqual([200, 410]);

    const list = await app.inject({ method: 'GET', url: `/api/rooms/${room.id}/invites`, headers: auth(owner.token) });
    expect(list.json().invites[0].usedCount).toBe(1);

    // 未成功的那位不应残留成员资格
    const members = await app.inject({ method: 'GET', url: `/api/rooms/${room.id}`, headers: auth(owner.token) });
    expect(members.json().members.length).toBe(2); // 房主 + 成功的一位
  });

  it('同一用户并发兑换两次：不产生 500', async () => {
    const owner = await registerUser('reg_inv_same_owner');
    const u = await registerUser('reg_inv_same');
    const room = await createRoom(owner.token, '并发同人房');
    const code = (
      await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/invites`, headers: auth(owner.token), payload: {} })
    ).json().invite.code;

    const [a, b] = await Promise.all([
      app.inject({ method: 'POST', url: `/api/invites/${code}/redeem`, headers: auth(u.token) }),
      app.inject({ method: 'POST', url: `/api/invites/${code}/redeem`, headers: auth(u.token) }),
    ]);
    expect([a.statusCode, b.statusCode].every((c) => c === 200)).toBe(true);

    const list = await app.inject({ method: 'GET', url: `/api/rooms/${room.id}/invites`, headers: auth(owner.token) });
    expect(list.json().invites[0].usedCount).toBe(1);
  });
});

describe('入参校验（修复：非法 id/类型 → 500）', () => {
  it('各类非法 id 返回 4xx 而不是 500', async () => {
    const u = await registerUser('reg_bad_id');
    const cases = [
      { url: '/api/rooms/not-a-uuid', method: 'GET' as const },
      { url: '/api/dm/not-a-uuid/messages', method: 'GET' as const },
      { url: '/api/users/not-a-uuid', method: 'GET' as const },
      { url: '/api/friends/not-a-uuid/remove', method: 'POST' as const },
    ];
    for (const c of cases) {
      const res = await app.inject({ method: c.method, url: c.url, headers: auth(u.token) });
      expect(res.statusCode, c.url).toBeGreaterThanOrEqual(400);
      expect(res.statusCode, c.url).toBeLessThan(500);
    }
  });

  it('WS 非法 id / 非字符串文本 → invalid_input（不再 internal_error）', async () => {
    const owner = await registerUser('reg_ws_bad');
    const room = await createRoom(owner.token, 'WS 校验房');
    const ws = await connectWs(owner.token);
    await joinWs(ws, room.id);

    // text 为非字符串：修复前 safeText 里 .trim() 抛错 → internal_error
    const e1 = nextMessage(ws, (m) => m.type === 'error');
    sendWs(ws, 'message:send', { roomId: room.id, text: 123 });
    expect((await e1).payload.code).toBe('empty_message');

    const e2 = nextMessage(ws, (m) => m.type === 'error');
    sendWs(ws, 'message:recall', { roomId: room.id, messageId: 'not-a-uuid' });
    expect((await e2).payload.code).toBe('invalid_input');

    const e3 = nextMessage(ws, (m) => m.type === 'error');
    sendWs(ws, 'member:kick', { roomId: room.id, userId: 'not-a-uuid' });
    expect(['invalid_input', 'target_not_in_room']).toContain((await e3).payload.code);
    ws.close();
  });
});

describe('信令体校验（修复：畸形 data 会被原样转发给对端）', () => {
  it('非法类型 / 超长 SDP / 非对象 data 一律拒绝', async () => {
    const owner = await registerUser('reg_sig_owner2');
    const peer = await registerUser('reg_sig_peer2');
    const room = await createRoom(owner.token, '信令校验房');
    await app.inject({ method: 'POST', url: '/api/rooms/join', headers: auth(peer.token), payload: { inviteCode: room.inviteCode } });

    const ws = await connectWs(owner.token);
    await joinWs(ws, room.id);

    const cases: Array<Record<string, unknown>> = [
      { roomId: room.id, to: peer.userId, data: { type: 'evil' } },
      { roomId: room.id, to: peer.userId, data: 'not-an-object' },
      { roomId: room.id, to: peer.userId, data: { type: 'offer', sdp: 'x'.repeat(20_000) } },
      { roomId: room.id, to: peer.userId, data: { type: 'request', cid: 'x'.repeat(80) } },
    ];
    for (const payload of cases) {
      const err = nextMessage(ws, (m) => m.type === 'error');
      sendWs(ws, 'screen:signal', payload);
      expect((await err).payload.code).toBe('invalid_input');
    }

    // 合法信令仍然透传
    const wsPeer = await connectWs(peer.token);
    await joinWs(wsPeer, room.id);
    const atPeer = nextMessage(wsPeer, (m) => m.type === 'screen:signal');
    sendWs(ws, 'screen:signal', { roomId: room.id, to: peer.userId, data: { type: 'request', cid: 'c1' } });
    expect((await atPeer).payload.data).toMatchObject({ type: 'request', cid: 'c1' });
    ws.close();
    wsPeer.close();
  });
});

describe('代理信任（修复：公网可伪造 X-Forwarded-For）', () => {
  it('只有回环/私网来源才信任 XFF', () => {
    expect(isTrustedProxy('127.0.0.1')).toBe(true);
    expect(isTrustedProxy('::1')).toBe(true);
    expect(isTrustedProxy('10.1.0.7')).toBe(true);
    expect(isTrustedProxy('192.168.1.20')).toBe(true);
    expect(isTrustedProxy('172.18.0.5')).toBe(true);
    expect(isTrustedProxy('fd00::1')).toBe(true);
    expect(isTrustedProxy('123.207.234.50')).toBe(false);
    expect(isTrustedProxy('8.8.8.8')).toBe(false);
    expect(isTrustedProxy(undefined)).toBe(false);
  });
});
