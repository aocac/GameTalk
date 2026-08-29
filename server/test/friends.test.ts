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

describe('friends', () => {
  it('request by username creates pending; duplicate rejected; incoming list shows it', async () => {
    const a = await registerUser('fr_req_a');
    const b = await registerUser('fr_req_b');

    const res = await app.inject({
      method: 'POST',
      url: '/api/friends/requests',
      headers: auth(a.token),
      payload: { username: 'fr_req_b' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().request.status).toBe('pending');
    expect(res.json().request.user.username).toBe('fr_req_b');

    const dup = await app.inject({
      method: 'POST',
      url: '/api/friends/requests',
      headers: auth(a.token),
      payload: { username: 'fr_req_b' },
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('request_pending');

    const list = await app.inject({ method: 'GET', url: '/api/friends/requests', headers: auth(b.token) });
    expect(list.json().incoming.map((r: any) => r.user.username)).toContain('fr_req_a');
    expect(list.json().outgoing).toEqual([]);
  });

  it('cannot add self / unknown user 404 / lookup by #shortid works', async () => {
    const a = await registerUser('fr_self');
    const self = await app.inject({
      method: 'POST',
      url: '/api/friends/requests',
      headers: auth(a.token),
      payload: { username: 'fr_self' },
    });
    expect(self.statusCode).toBe(400);

    const ghost = await app.inject({
      method: 'POST',
      url: '/api/friends/requests',
      headers: auth(a.token),
      payload: { username: 'no_such_user' },
    });
    expect(ghost.statusCode).toBe(404);

    const short = `#${a.userId.slice(0, 8)}`;
    const byShort = await app.inject({
      method: 'POST',
      url: '/api/friends/requests',
      headers: auth(a.token),
      payload: { username: short },
    });
    expect(byShort.statusCode).toBe(400); // 命中自己（短 ID 解析正确性）
    expect(byShort.json().error.code).toBe('cannot_add_self');
  });

  it('reverse request auto-accepts; WS friend:accepted reaches the original requester; list shows both with online flag', async () => {
    const a = await registerUser('fr_pair_a');
    const b = await registerUser('fr_pair_b');

    const wsA = await connectWs(a.token);
    const accepted = nextMessage(wsA, (m) => m.type === 'friend:accepted');

    await app.inject({
      method: 'POST',
      url: '/api/friends/requests',
      headers: auth(a.token),
      payload: { userId: b.userId },
    });
    // B 反向申请 = 互加
    const res = await app.inject({
      method: 'POST',
      url: '/api/friends/requests',
      headers: auth(b.token),
      payload: { userId: a.userId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().request.status).toBe('accepted');

    const ev = await accepted;
    expect(ev.payload.user.username).toBe('fr_pair_b');

    // B 连上 WS → 好友列表的 online 标记应反映实时连接状态
    const wsB = await connectWs(b.token);
    const listA = await app.inject({ method: 'GET', url: '/api/friends', headers: auth(a.token) });
    expect(listA.json().friends.map((f: any) => f.username)).toEqual(['fr_pair_b']);
    expect(listA.json().friends[0].online).toBe(true);
    wsA.close();
    wsB.close();
  });

  it('accept flow notifies requester; decline and remove sync both sides with WS events', async () => {
    const a = await registerUser('fr_flow_a');
    const b = await registerUser('fr_flow_b');
    const wsA = await connectWs(a.token);
    const sendRequest = () =>
      app.inject({
        method: 'POST',
        url: '/api/friends/requests',
        headers: auth(a.token),
        payload: { userId: b.userId },
      });

    await sendRequest();
    const incoming = (
      await app.inject({ method: 'GET', url: '/api/friends/requests', headers: auth(b.token) })
    ).json().incoming[0];

    // 同意 → A 实时收到 friend:accepted
    const accepted = nextMessage(wsA, (m) => m.type === 'friend:accepted');
    const ok = await app.inject({
      method: 'POST',
      url: `/api/friends/requests/${incoming.id}/accept`,
      headers: auth(b.token),
    });
    expect(ok.statusCode).toBe(200);
    expect((await accepted).payload.user.username).toBe('fr_flow_b');

    // 已是好友时重复申请 → 409 already_friends
    const dup = await sendRequest();
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('already_friends');

    // B 删除好友 → 发起方 B 本地生效，A（被删方）实时收到 friend:removed，双向列表同步为空
    const removed = nextMessage(wsA, (m) => m.type === 'friend:removed');
    const remove1 = await app.inject({ method: 'POST', url: `/api/friends/${a.userId}/remove`, headers: auth(b.token) });
    expect(remove1.statusCode).toBe(200);
    expect((await removed).payload.userId).toBe(b.userId);
    const listA = await app.inject({ method: 'GET', url: '/api/friends', headers: auth(a.token) });
    const listB = await app.inject({ method: 'GET', url: '/api/friends', headers: auth(b.token) });
    expect(listA.json().friends).toEqual([]);
    expect(listB.json().friends).toEqual([]);

    // 拒绝流程：A 重新申请，B 拒绝 → A 实时收到 friend:declined
    await sendRequest();
    const incoming2 = (
      await app.inject({ method: 'GET', url: '/api/friends/requests', headers: auth(b.token) })
    ).json().incoming[0];
    const declined = nextMessage(wsA, (m) => m.type === 'friend:declined');
    const no = await app.inject({
      method: 'POST',
      url: `/api/friends/requests/${incoming2.id}/decline`,
      headers: auth(b.token),
    });
    expect(no.statusCode).toBe(200);
    expect((await declined).payload.userId).toBe(b.userId);
    const afterDecline = await app.inject({ method: 'GET', url: '/api/friends/requests', headers: auth(b.token) });
    expect(afterDecline.json().incoming).toEqual([]);
    wsA.close();
  });

  it('presence:friend events notify online friends on connect/disconnect', async () => {
    const a = await registerUser('fr_pres_a');
    const b = await registerUser('fr_pres_b');
    await app.inject({ method: 'POST', url: '/api/friends/requests', headers: auth(a.token), payload: { userId: b.userId } });
    const req = (await app.inject({ method: 'GET', url: '/api/friends/requests', headers: auth(b.token) })).json().incoming[0];
    await app.inject({ method: 'POST', url: `/api/friends/requests/${req.id}/accept`, headers: auth(b.token) });

    // B 先在线；A 上线 → B 收到 online:true；A 断开 → B 收到 online:false
    const wsB = await connectWs(b.token);
    const bSeesOnline = nextMessage(wsB, (m) => m.type === 'presence:friend');
    const wsA = await connectWs(a.token);
    expect((await bSeesOnline).payload).toMatchObject({ userId: a.userId, online: true });

    const bSeesOffline = nextMessage(wsB, (m) => m.type === 'presence:friend' && m.payload.online === false);
    wsA.close();
    expect((await bSeesOffline).payload).toMatchObject({ userId: a.userId, online: false });
    wsB.close();
  });
});
