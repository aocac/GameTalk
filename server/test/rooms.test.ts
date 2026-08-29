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
  it('persists messages and paginates history (with avatar)', async () => {
    const owner = await registerUser('hist_owner');
    const { room } = (
      await app.inject({ method: 'POST', url: '/api/rooms', headers: auth(owner.token), payload: { name: 'Hist' } })
    ).json();

    // 给 owner 设置头像，验证消息携带 avatarUrl
    const pngBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    await app.inject({
      method: 'POST',
      url: '/api/auth/avatar',
      headers: auth(owner.token),
      payload: { dataUrl: `data:image/png;base64,${pngBase64}` },
    });

    const ws = await connectWs(owner.token);
    ws.send(JSON.stringify({ type: 'room:join', payload: { roomId: room.id } }));
    await nextMessage(ws, (m) => m.type === 'room:joined');

    // 发 3 条
    for (let i = 1; i <= 3; i++) {
      const got = nextMessage(ws, (m) => m.type === 'message:new');
      ws.send(JSON.stringify({ type: 'message:send', payload: { roomId: room.id, text: `msg-${i}` } }));
      const msg = await got;
      // 头像已改为 HTTP 端点 URL，不再内嵌 base64
      expect(msg.payload.message.avatarUrl).toMatch(/\/api\/avatars\/[0-9a-f-]{36}$/);
    }

    // 历史拉取
    const res = await app.inject({ method: 'GET', url: `/api/rooms/${room.id}/messages`, headers: auth(owner.token) });
    expect(res.statusCode).toBe(200);
    const { messages } = res.json();
    expect(messages.map((m: any) => m.text)).toEqual(['msg-1', 'msg-2', 'msg-3']);
    expect(messages[0].username).toBe('hist_owner');
    expect(messages[0].avatarUrl).toMatch(/\/api\/avatars\/[0-9a-f-]{36}$/);
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

  it('roster includes offline members with online flags (QQ-style presence)', async () => {
    const owner = await registerUser('roster_owner');
    const { room } = (
      await app.inject({ method: 'POST', url: '/api/rooms', headers: auth(owner.token), payload: { name: 'Roster' } })
    ).json();

    // 离线成员：只走 REST 加入（DB 花名册），从不开 WS 连接
    const offline = await registerUser('roster_offline');
    await app.inject({
      method: 'POST',
      url: '/api/rooms/join',
      headers: auth(offline.token),
      payload: { inviteCode: room.inviteCode },
    });

    const ws = await connectWs(owner.token);
    ws.send(JSON.stringify({ type: 'room:join', payload: { roomId: room.id } }));
    const joined = await nextMessage(ws, (m) => m.type === 'room:joined');
    const findMember = (ms: any[], username: string) => ms.find((m) => m.username === username);
    expect(findMember(joined.payload.members, 'roster_owner').online).toBe(true);
    expect(findMember(joined.payload.members, 'roster_offline').online).toBe(false);

    // 离线成员上线：其他人收到 member:joined，重订阅后花名册标记在线
    const wsOffline = await connectWs(offline.token);
    const oSeesJoin = nextMessage(
      ws,
      (m) => m.type === 'member:joined' && m.payload.member.username === 'roster_offline',
    );
    wsOffline.send(JSON.stringify({ type: 'room:join', payload: { roomId: room.id } }));
    await nextMessage(wsOffline, (m) => m.type === 'room:joined');
    await oSeesJoin;

    const resubscribe = async (): Promise<any[]> => {
      ws.send(JSON.stringify({ type: 'room:leave', payload: { roomId: room.id } }));
      ws.send(JSON.stringify({ type: 'room:join', payload: { roomId: room.id } }));
      const again = await nextMessage(ws, (m) => m.type === 'room:joined');
      return again.payload.members;
    };

    let members = await resubscribe();
    expect(findMember(members, 'roster_offline').online).toBe(true);

    // 下线：成员不被移除，仍留在花名册，仅标记离线（QQ 式置灰）
    const oSeesLeft = nextMessage(
      ws,
      (m) => m.type === 'member:left' && m.payload.userId === offline.userId,
    );
    wsOffline.close();
    await oSeesLeft;

    members = await resubscribe();
    const goneOffline = findMember(members, 'roster_offline');
    expect(goneOffline).toBeTruthy();
    expect(goneOffline.online).toBe(false);
    ws.close();
  });

  it('parses and stores @mentions (explicit picks + text scan, members only)', async () => {
    const owner = await registerUser('mention_owner');
    const { room } = (
      await app.inject({ method: 'POST', url: '/api/rooms', headers: auth(owner.token), payload: { name: 'Mentions' } })
    ).json();
    const member = await registerUser('mention_member');
    await app.inject({
      method: 'POST',
      url: '/api/rooms/join',
      headers: auth(member.token),
      payload: { inviteCode: room.inviteCode },
    });
    // 非成员：验证提及他不会生效
    await registerUser('mention_outside');

    const ws = await connectWs(owner.token);
    ws.send(JSON.stringify({ type: 'room:join', payload: { roomId: room.id } }));
    await nextMessage(ws, (m) => m.type === 'room:joined');

    // 文本解析 + 显式 picks（重复去重）；提及自己应被剔除
    const got = nextMessage(ws, (m) => m.type === 'message:new');
    ws.send(
      JSON.stringify({
        type: 'message:send',
        payload: { roomId: room.id, text: '今晚 @mention_member 和 @mention_owner 一起上号', mentions: [member.userId, owner.userId] },
      }),
    );
    const msg = await got;
    expect(msg.payload.message.mentions).toEqual([{ id: member.userId, username: 'mention_member' }]);

    // 非房间成员不算提及
    const got2 = nextMessage(ws, (m) => m.type === 'message:new');
    ws.send(JSON.stringify({ type: 'message:send', payload: { roomId: room.id, text: '找不到 @mention_outside' } }));
    expect((await got2).payload.message.mentions).toEqual([]);
    ws.close();

    // 历史接口带出 mentions
    const hist = await app.inject({ method: 'GET', url: `/api/rooms/${room.id}/messages`, headers: auth(owner.token) });
    const { messages } = hist.json();
    expect(messages[0].mentions).toEqual([{ id: member.userId, username: 'mention_member' }]);
    expect(messages[1].mentions).toEqual([]);
  });

  it('image messages: upload → send → broadcast/history carry kind and absolute mediaUrl', async () => {
    const owner = await registerUser('media_owner');
    const { room } = (
      await app.inject({ method: 'POST', url: '/api/rooms', headers: auth(owner.token), payload: { name: 'Media' } })
    ).json();
    const pngDataUrl =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

    // 垃圾数据拒绝
    const bad = await app.inject({
      method: 'POST',
      url: '/api/media',
      headers: { ...auth(owner.token), 'content-type': 'application/json' },
      payload: { dataUrl: 'data:image/png;base64,not-png' },
    });
    expect(bad.statusCode).toBe(400);

    const up = await app.inject({
      method: 'POST',
      url: '/api/media',
      headers: { ...auth(owner.token), 'content-type': 'application/json' },
      payload: { dataUrl: pngDataUrl },
    });
    expect(up.statusCode).toBe(201);
    const { id, url } = up.json();
    expect(url).toBe(`/api/media/${id}`);

    // 读取：免认证（<img> 带不了 Authorization 头），字节与类型正确
    const got = await app.inject({ method: 'GET', url: `/api/media/${id}`, headers: auth(owner.token) });
    expect(got.statusCode).toBe(200);
    expect(got.headers['content-type']).toBe('image/png');
    const anon = await app.inject({ method: 'GET', url: `/api/media/${id}` });
    expect(anon.statusCode).toBe(200);

    const ws = await connectWs(owner.token);
    ws.send(JSON.stringify({ type: 'room:join', payload: { roomId: room.id } }));
    await nextMessage(ws, (m) => m.type === 'room:joined');

    const got1 = nextMessage(ws, (m) => m.type === 'message:new');
    ws.send(JSON.stringify({ type: 'message:send', payload: { roomId: room.id, text: '', mediaUrl: url } }));
    const msg = await got1;
    expect(msg.payload.message.kind).toBe('image');
    expect(msg.payload.message.mediaUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/media\/[0-9a-f-]{36}$/);

    // 伪造他人/不存在的媒体引用 → invalid_input
    const errPromise = nextMessage(ws, (m) => m.type === 'error');
    ws.send(
      JSON.stringify({ type: 'message:send', payload: { roomId: room.id, text: '', mediaUrl: `/api/media/${'0'.repeat(8)}-0000-4000-8000-000000000000` } }),
    );
    expect((await errPromise).payload.code).toBe('invalid_input');

    const hist = await app.inject({ method: 'GET', url: `/api/rooms/${room.id}/messages`, headers: auth(owner.token) });
    const { messages } = hist.json();
    const img = messages.find((m: any) => m.kind === 'image');
    expect(img.mediaUrl).toMatch(/\/api\/media\/[0-9a-f-]{36}$/);
    ws.close();
  });

  it('mute: owner-only, blocks sending with mutedUntil, unmute restores, owner immune', async () => {
    const owner = await registerUser('mute_owner');
    const { room } = (
      await app.inject({ method: 'POST', url: '/api/rooms', headers: auth(owner.token), payload: { name: 'MuteRoom' } })
    ).json();
    const member = await registerUser('mute_member');
    await app.inject({
      method: 'POST',
      url: '/api/rooms/join',
      headers: auth(member.token),
      payload: { inviteCode: room.inviteCode },
    });

    const wsO = await connectWs(owner.token);
    const wsM = await connectWs(member.token);
    for (const w of [wsO, wsM]) {
      w.send(JSON.stringify({ type: 'room:join', payload: { roomId: room.id } }));
      await nextMessage(w, (m) => m.type === 'room:joined');
    }

    // 非房主禁言 → only_owner
    const e1 = nextMessage(wsM, (m) => m.type === 'error');
    wsM.send(JSON.stringify({ type: 'member:mute', payload: { roomId: room.id, userId: owner.userId, minutes: 10 } }));
    expect((await e1).payload.code).toBe('only_owner');

    // 房主禁言自己 → invalid_input
    const e2 = nextMessage(wsO, (m) => m.type === 'error');
    wsO.send(JSON.stringify({ type: 'member:mute', payload: { roomId: room.id, userId: owner.userId, minutes: 10 } }));
    expect((await e2).payload.code).toBe('invalid_input');

    // 正常禁言：双方收到 member:muted，花名册带 mutedUntil
    const oSeesMuted = nextMessage(wsO, (m) => m.type === 'member:muted');
    const mSeesMuted = nextMessage(wsM, (m) => m.type === 'member:muted');
    wsO.send(JSON.stringify({ type: 'member:mute', payload: { roomId: room.id, userId: member.userId, minutes: 10 } }));
    const mutedEv = await oSeesMuted;
    expect(mutedEv.payload.userId).toBe(member.userId);
    expect(mutedEv.payload.mutedUntil).toBeTruthy();
    await mSeesMuted;

    // 重新订阅拿花名册：mutedUntil 应带出
    wsM.send(JSON.stringify({ type: 'room:leave', payload: { roomId: room.id } }));
    wsM.send(JSON.stringify({ type: 'room:join', payload: { roomId: room.id } }));
    const rejoined = await nextMessage(wsM, (m) => m.type === 'room:joined');
    const meEntry = rejoined.payload.members.find((x: any) => x.id === member.userId);
    expect(meEntry.mutedUntil).toBeTruthy();

    // 被禁言者发消息 → muted 错误
    const e3 = nextMessage(wsM, (m) => m.type === 'error');
    wsM.send(JSON.stringify({ type: 'message:send', payload: { roomId: room.id, text: ' hello' } }));
    const mutedErr = await e3;
    expect(mutedErr.payload.code).toBe('muted');
    expect(mutedErr.payload.mutedUntil).toBeTruthy();

    // 解除禁言 → 发送恢复
    const mSeesUnmuted = nextMessage(wsM, (m) => m.type === 'member:unmuted');
    wsO.send(JSON.stringify({ type: 'member:unmute', payload: { roomId: room.id, userId: member.userId } }));
    await mSeesUnmuted;
    const got = nextMessage(wsO, (m) => m.type === 'message:new');
    wsM.send(JSON.stringify({ type: 'message:send', payload: { roomId: room.id, text: '解封发言' } }));
    expect((await got).payload.message.text).toBe('解封发言');

    wsO.close();
    wsM.close();
  });
});
