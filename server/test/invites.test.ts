import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createDb, type Db } from '../src/db/db.js';
import { runMigrations } from '../src/db/migrate.js';
import { loadConfig } from '../src/config.js';
import { createJwtService } from '../src/lib/jwt.js';

let app: FastifyInstance;
let db: Db;

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

async function createRoom(token: string, name: string): Promise<{ id: string }> {
  const res = await app.inject({ method: 'POST', url: '/api/rooms', headers: auth(token), payload: { name } });
  expect(res.statusCode).toBe(201);
  return res.json().room;
}

async function joinByCode(token: string, inviteCode: string): Promise<void> {
  const res = await app.inject({ method: 'POST', url: '/api/rooms/join', headers: auth(token), payload: { inviteCode } });
  expect(res.statusCode).toBe(200);
}

beforeAll(async () => {
  db = createDb(loadConfig({ NODE_ENV: 'test' }));
  await runMigrations(db);
  const jwt = createJwtService('test-secret', '1h');
  app = await buildApp({ config: loadConfig({ NODE_ENV: 'test' }), db, jwt });
  await app.listen({ host: '127.0.0.1', port: 0 });
});

afterAll(async () => {
  await app.close();
  await db.close();
});

describe('invite links', () => {
  it('members create; params validated; non-members denied', async () => {
    const owner = await registerUser('inv_owner');
    const member = await registerUser('inv_member');
    const outsider = await registerUser('inv_out');
    const room = await createRoom(owner.token, '邀请房');
    await joinByCode(member.token, room.inviteCode);

    // 非成员不能创建
    const deny = await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/invites`, headers: auth(outsider.token), payload: {} });
    expect(deny.statusCode).toBe(403);

    // 成员创建：默认永久不限次
    const ok = await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/invites`, headers: auth(member.token), payload: {} });
    expect(ok.statusCode).toBe(201);
    const inv = ok.json().invite;
    expect(inv.code).toHaveLength(16);
    expect(inv.expiresAt).toBeNull();
    expect(inv.maxUses).toBe(0);

    // 参数越界拒绝
    const badHours = await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/invites`, headers: auth(member.token), payload: { expiresInHours: 99999 } });
    expect(badHours.statusCode).toBe(400);
    const negHours = await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/invites`, headers: auth(member.token), payload: { expiresInHours: -1 } });
    expect(negHours.statusCode).toBe(400);
    const badUses = await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/invites`, headers: auth(member.token), payload: { maxUses: 501 } });
    expect(badUses.statusCode).toBe(400);
  });

  it('preview returns room info and validity; 404 for unknown code', async () => {
    const owner = await registerUser('inv_prev_owner');
    const room = await createRoom(owner.token, '预览房');
    const created = await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/invites`, headers: auth(owner.token), payload: { expiresInHours: 1 } });
    const code = created.json().invite.code;

    const nope = await app.inject({ method: 'GET', url: '/api/invites/ZZZZZZZZZZZZZZZZ', headers: auth(owner.token) });
    expect(nope.statusCode).toBe(404);

    const preview = await app.inject({ method: 'GET', url: `/api/invites/${code}`, headers: auth(owner.token) });
    expect(preview.statusCode).toBe(200);
    const body = preview.json().invite;
    expect(body).toMatchObject({ roomName: '预览房', inviterName: 'inv_prev_owner', valid: true, alreadyMember: true });
    expect(body.expiresAt).not.toBeNull();
  });

  it('redeem joins room and counts once per user; idempotent for existing members', async () => {
    const owner = await registerUser('inv_red_owner');
    const u1 = await registerUser('inv_red_1');
    const u2 = await registerUser('inv_red_2');
    const room = await createRoom(owner.token, '兑换房');
    const code = (await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/invites`, headers: auth(owner.token), payload: { maxUses: 2 } })).json().invite.code;

    const r1 = await app.inject({ method: 'POST', url: `/api/invites/${code}/redeem`, headers: auth(u1.token) });
    expect(r1.statusCode).toBe(200);
    expect(r1.json().room.id).toBe(room.id);

    // 同一人重复 redeem：幂等（不重复计数、不重复入房）
    const r1again = await app.inject({ method: 'POST', url: `/api/invites/${code}/redeem`, headers: auth(u1.token) });
    expect(r1again.statusCode).toBe(200);

    const r2 = await app.inject({ method: 'POST', url: `/api/invites/${code}/redeem`, headers: auth(u2.token) });
    expect(r2.statusCode).toBe(200);

    // maxUses=2 已用完（u1、u2 各计一次）：第三人被拒
    const u3 = await registerUser('inv_red_3');
    const r3 = await app.inject({ method: 'POST', url: `/api/invites/${code}/redeem`, headers: auth(u3.token) });
    expect(r3.statusCode).toBe(410);
    expect(r3.json().error.code).toBe('invite_exhausted');

    // 计数核对：恰好 2
    const list = await app.inject({ method: 'GET', url: `/api/rooms/${room.id}/invites`, headers: auth(owner.token) });
    expect(list.json().invites[0].usedCount).toBe(2);
  });

  it('expired and revoked invites rejected; owner sees all invites, member only own', async () => {
    const owner = await registerUser('inv_exp_owner');
    const member = await registerUser('inv_exp_member');
    const stranger = await registerUser('inv_exp_stranger');
    const room = await createRoom(owner.token, '过期房');
    await joinByCode(member.token, room.inviteCode);

    // 直接造一条已过期链接（绕过真实时间等待）
    const expired = await db.query<{ code: string }>(
      `INSERT INTO invite_links (room_id, code, created_by, expires_at)
       VALUES ($1, 'EXPIREDLINK0001', $2, now() - interval '1 hour') RETURNING code`,
      [room.id, owner.userId],
    );
    const e = await app.inject({ method: 'POST', url: `/api/invites/${expired.rows[0].code}/redeem`, headers: auth(stranger.token) });
    expect(e.statusCode).toBe(410);
    expect(e.json().error.code).toBe('invite_expired');

    // 成员创建自己的链接；房主创建另一条
    const memberInv = (await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/invites`, headers: auth(member.token), payload: {} })).json().invite;
    await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/invites`, headers: auth(owner.token), payload: {} });

    // 列表：房主看到全部 3 条（含过期那条），成员只看到自己的 1 条
    const ownerList = await app.inject({ method: 'GET', url: `/api/rooms/${room.id}/invites`, headers: auth(owner.token) });
    expect(ownerList.json().invites).toHaveLength(3);
    const memberList = await app.inject({ method: 'GET', url: `/api/rooms/${room.id}/invites`, headers: auth(member.token) });
    expect(memberList.json().invites).toHaveLength(1);
    expect(memberList.json().invites[0].code).toBe(memberInv.code);

    // 吊销：无关成员不能吊销他人链接
    const deny = await app.inject({ method: 'DELETE', url: `/api/invites/${memberInv.code}`, headers: auth(stranger.token) });
    expect(deny.statusCode).toBe(403);
    // 房主可以吊销成员创建的链接
    const revoke = await app.inject({ method: 'DELETE', url: `/api/invites/${memberInv.code}`, headers: auth(owner.token) });
    expect(revoke.statusCode).toBe(200);
    // 吊销后 redeem 404
    const afterRevoke = await app.inject({ method: 'POST', url: `/api/invites/${memberInv.code}/redeem`, headers: auth(stranger.token) });
    expect(afterRevoke.statusCode).toBe(404);
  });
});
