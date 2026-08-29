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

/** 建立一对好友并返回双方凭据 */
async function makeFriendPair(prefix: string): Promise<{ a: { token: string; userId: string }; b: { token: string; userId: string } }> {
  const a = await registerUser(`${prefix}_a`);
  const b = await registerUser(`${prefix}_b`);
  await app.inject({ method: 'POST', url: '/api/friends/requests', headers: auth(a.token), payload: { userId: b.userId } });
  await app.inject({ method: 'POST', url: '/api/friends/requests', headers: auth(b.token), payload: { userId: a.userId } });
  return { a, b };
}

function dmSend(ws: WebSocket, to: string, text: string, extra: Record<string, unknown> = {}): void {
  ws.send(JSON.stringify({ type: 'dm:send', payload: { to, text, ...extra } }));
}

describe('dm', () => {
  it('non-friends cannot dm; empty message rejected', async () => {
    const a = await registerUser('dm_stranger_a');
    const b = await registerUser('dm_stranger_b');
    const wsA = await connectWs(a.token);
    const err = nextMessage(wsA, (m) => m.type === 'error');
    dmSend(wsA, b.userId, '你好');
    expect((await err).payload.code).toBe('not_friends');

    // 成为好友后空文本仍拒绝
    const wsB = await connectWs(b.token);
    await app.inject({ method: 'POST', url: '/api/friends/requests', headers: auth(a.token), payload: { userId: b.userId } });
    await app.inject({ method: 'POST', url: '/api/friends/requests', headers: auth(b.token), payload: { userId: a.userId } });
    const err2 = nextMessage(wsA, (m) => m.type === 'error');
    dmSend(wsA, b.userId, '   ');
    expect((await err2).payload.code).toBe('empty_message');
    wsA.close();
    wsB.close();
  });

  it('friends exchange dm; both sides receive dm:new with message fields', async () => {
    const { a, b } = await makeFriendPair('dm_pair');
    const wsA = await connectWs(a.token);
    const wsB = await connectWs(b.token);
    const gotAtB = nextMessage(wsB, (m) => m.type === 'dm:new');
    const gotAtA = nextMessage(wsA, (m) => m.type === 'dm:new');

    dmSend(wsA, b.userId, '吃鸡吗？');

    const atA = await gotAtA;
    const atB = await gotAtB;
    for (const ev of [atA, atB]) {
      expect(ev.payload.message).toMatchObject({
        from: a.userId,
        to: b.userId,
        username: 'dm_pair_a',
        text: '吃鸡吗？',
        kind: 'text',
        recalled: false,
      });
      expect(ev.payload.message.id).toBeTruthy();
      expect(ev.payload.message.createdAt).toBeTruthy();
    }
    wsA.close();
    wsB.close();
  });

  it('history: friends read ascending with hasMore; non-friends get 403', async () => {
    const { a, b } = await makeFriendPair('dm_hist');
    const wsA = await connectWs(a.token);
    const wsB = await connectWs(b.token);
    for (let i = 1; i <= 3; i++) {
      const ack = nextMessage(wsA, (m) => m.type === 'dm:new');
      dmSend(wsA, b.userId, `msg${i}`);
      await ack;
    }
    wsA.close();
    wsB.close();

    const full = await app.inject({ method: 'GET', url: `/api/dm/${b.userId}/messages`, headers: auth(a.token) });
    expect(full.statusCode).toBe(200);
    const body = full.json();
    expect(body.messages.map((m: any) => m.text)).toEqual(['msg1', 'msg2', 'msg3']);
    expect(body.messages[0].from).toBe(a.userId);
    expect(body.hasMore).toBe(false);

    // 游标分页：before=第 3 条 → 返回前 2 条
    const paged = await app.inject({
      method: 'GET',
      url: `/api/dm/${b.userId}/messages?before=${body.messages[2].id}&limit=2`,
      headers: auth(a.token),
    });
    expect(paged.json().messages.map((m: any) => m.text)).toEqual(['msg1', 'msg2']);
    expect(paged.json().hasMore).toBe(false);

    // 非好友拉历史 → 403
    const stranger = await registerUser('dm_hist_stranger');
    const forbidden = await app.inject({ method: 'GET', url: `/api/dm/${b.userId}/messages`, headers: auth(stranger.token) });
    expect(forbidden.statusCode).toBe(403);
  });

  it('conversations returns the latest message per peer, newest conversation first', async () => {
    const x = await makeFriendPair('dm_conv_x');
    const y = await makeFriendPair('dm_conv_y');
    // a 与 x.a、y.a 都是好友，用 a 聚合会话
    const a = await registerUser('dm_conv_main');
    for (const peer of [x.a, y.a]) {
      await app.inject({ method: 'POST', url: '/api/friends/requests', headers: auth(a.token), payload: { userId: peer.userId } });
      await app.inject({ method: 'POST', url: '/api/friends/requests', headers: auth(peer.token), payload: { userId: a.userId } });
    }
    const wsA = await connectWs(a.token);
    const wsX = await connectWs(x.a.token);
    const wsY = await connectWs(y.a.token);
    for (const [peer, ws, text] of [
      [x.a.userId, wsX, '来自x的最后一条'],
      [y.a.userId, wsY, '来自y的第一条'],
      [y.a.userId, wsY, '来自y的最后一条'],
    ] as const) {
      const ack = nextMessage(ws, (m) => m.type === 'dm:new');
      dmSend(wsA, peer, text);
      await ack;
    }
    wsA.close();
    wsX.close();
    wsY.close();

    const conv = await app.inject({ method: 'GET', url: '/api/dm/conversations', headers: auth(a.token) });
    expect(conv.statusCode).toBe(200);
    const items = conv.json().conversations;
    expect(items).toHaveLength(2);
    const byPeer = new Map(items.map((c: any) => [c.peerId, c.last.text]));
    expect(byPeer.get(x.a.userId)).toBe('来自x的最后一条');
    expect(byPeer.get(y.a.userId)).toBe('来自y的最后一条');
    // 会话按最后消息时间倒序：y 会话在后发，应排最前
    expect(items[0].peerId).toBe(y.a.userId);
  });

  it('recall: sender can recall (both notified), recipient cannot recall others message', async () => {
    const { a, b } = await makeFriendPair('dm_recall');
    const wsA = await connectWs(a.token);
    const wsB = await connectWs(b.token);
    const gotAtB = nextMessage(wsB, (m) => m.type === 'dm:new');
    dmSend(wsA, b.userId, '待撤回');
    const sent = (await gotAtB).payload.message;

    // 接收者 B 撤回 A 的消息 → only_sender
    const deny = nextMessage(wsB, (m) => m.type === 'error');
    wsB.send(JSON.stringify({ type: 'dm:recall', payload: { messageId: sent.id } }));
    expect((await deny).payload.code).toBe('only_sender');

    // 发送者 A 撤回 → 双方收到 dm:recalled
    const recallAtA = nextMessage(wsA, (m) => m.type === 'dm:recalled');
    const recallAtB = nextMessage(wsB, (m) => m.type === 'dm:recalled');
    wsA.send(JSON.stringify({ type: 'dm:recall', payload: { messageId: sent.id } }));
    expect((await recallAtA).payload).toMatchObject({ messageId: sent.id, from: a.userId, to: b.userId });
    expect((await recallAtB).payload.messageId).toBe(sent.id);

    // 历史中该消息已置 recalled
    const hist = await app.inject({ method: 'GET', url: `/api/dm/${b.userId}/messages`, headers: auth(a.token) });
    expect(hist.json().messages[0]).toMatchObject({ id: sent.id, recalled: true, text: '' });

    // 重复撤回 → message_not_found（已撤回的消息不再命中）
    const again = nextMessage(wsA, (m) => m.type === 'error');
    wsA.send(JSON.stringify({ type: 'dm:recall', payload: { messageId: sent.id } }));
    expect((await again).payload.code).toBe('message_not_found');
    wsA.close();
    wsB.close();
  });

  it('image dm requires owned media; reply requires same-conversation target', async () => {
    const { a, b } = await makeFriendPair('dm_media');
    const wsA = await connectWs(a.token);
    const wsB = await connectWs(b.token);

    // 伪造他人媒体 URL → 拒绝
    const errMedia = nextMessage(wsA, (m) => m.type === 'error');
    dmSend(wsA, b.userId, '', { mediaUrl: '/api/media/00000000-0000-4000-8000-000000000000' });
    expect((await errMedia).payload.code).toBe('invalid_input');

    // 真实上传媒体后发送图片 DM（1x1 PNG dataUrl）
    const png =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const up = await app.inject({ method: 'POST', url: '/api/media', headers: auth(a.token), payload: { dataUrl: png } });
    expect(up.statusCode).toBe(201);
    const mediaUrl = up.json().url as string;
    const imgAck = nextMessage(wsB, (m) => m.type === 'dm:new');
    dmSend(wsA, b.userId, '', { mediaUrl });
    const imgMsg = (await imgAck).payload.message;
    expect(imgMsg).toMatchObject({ kind: 'image', text: '' });
    expect(String(imgMsg.mediaUrl)).toContain(mediaUrl);

    // B 引用该图片消息回复 → 快照 kind=image
    const replyAck = nextMessage(wsA, (m) => m.type === 'dm:new');
    dmSend(wsB, a.userId, '收到', { replyTo: imgMsg.id });
    const replyMsg = (await replyAck).payload.message;
    expect(replyMsg.reply).toMatchObject({ id: imgMsg.id, username: 'dm_media_a', kind: 'image' });

    // 跨会话引用（拿房间消息 id 或任意 uuid）→ message_not_found
    const errReply = nextMessage(wsB, (m) => m.type === 'error');
    dmSend(wsB, a.userId, '跨会话', { replyTo: '00000000-0000-4000-8000-000000000009' });
    expect((await errReply).payload.code).toBe('message_not_found');
    wsA.close();
    wsB.close();
  });
});
