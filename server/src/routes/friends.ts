import type { FastifyInstance } from 'fastify';
import type { QueryResultRow } from 'pg';
import type { Db } from '../db/db.js';
import type { JwtService } from '../lib/jwt.js';
import { avatarHttpUrlOf, httpBaseOf } from '../lib/avatar.js';
import { makeAuthPreHandler } from '../plugins/auth.js';
import { onlineUserIds, sendToUser } from '../ws/gateway.js';

export interface FriendsDeps {
  db: Db;
  jwt: JwtService;
}

interface UserRow extends QueryResultRow {
  id: string;
  username: string;
  avatar_url: string | null;
  bio: string | null;
}

interface FriendshipRow extends QueryResultRow {
  id: string;
  requester_id: string;
  addressee_id: string;
  status: string;
  created_at: string;
}

function publicUserOf(base: string, u: UserRow) {
  return {
    id: u.id,
    username: u.username,
    avatarUrl: avatarHttpUrlOf(base, u.id, u.avatar_url),
    bio: u.bio ?? null,
  };
}

/** 按 用户ID / 用户名 / #短ID前缀 查找用户 */
async function findTarget(db: Db, raw: string): Promise<UserRow | null> {
  const q = raw.trim();
  if (!q) return null;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(q)) {
    const byId = await db.query<UserRow>('SELECT id, username, avatar_url, bio FROM users WHERE id = $1', [q]);
    return byId.rows[0] ?? null;
  }
  if (/^#[0-9a-f]{8}$/i.test(q)) {
    const byShort = await db.query<UserRow>(
      'SELECT id, username, avatar_url, bio FROM users WHERE id::text LIKE $1 || \'%\'',
      [q.slice(1).toLowerCase()],
    );
    return byShort.rows[0] ?? null;
  }
  const byName = await db.query<UserRow>('SELECT id, username, avatar_url, bio FROM users WHERE username = $1', [q]);
  return byName.rows[0] ?? null;
}

export function registerFriendsRoutes(app: FastifyInstance, deps: FriendsDeps): void {
  const { db } = deps;
  const auth = makeAuthPreHandler(deps.jwt);

  // 好友列表（含在线状态，来自网关连接表）
  app.get('/api/friends', { preHandler: [auth] }, async (req, reply) => {
    const res = await db.query<UserRow>(
      `SELECT u.id, u.username, u.avatar_url, u.bio
       FROM friendships f
       JOIN users u ON u.id = CASE WHEN f.requester_id = $1 THEN f.addressee_id ELSE f.requester_id END
       WHERE f.status = 'accepted' AND (f.requester_id = $1 OR f.addressee_id = $1)
       ORDER BY u.username ASC`,
      [req.userId],
    );
    const online = onlineUserIds();
    const base = httpBaseOf(req.headers);
    await reply.send({
      friends: res.rows.map((u) => ({ ...publicUserOf(base, u), online: online.has(u.id) })),
    });
  });

  // 发好友申请：支持 userId / 用户名 / #短ID。对方已向我申请时视为互加（直接成为好友）
  app.post('/api/friends/requests', { preHandler: [auth] }, async (req, reply) => {
    const body = (req.body ?? {}) as { userId?: unknown; username?: unknown };
    const target = await findTarget(db, String(body.userId ?? body.username ?? ''));
    if (!target) {
      await reply.code(404).send({ error: { code: 'user_not_found', message: '用户不存在，请确认用户名或 ID' } });
      return;
    }
    if (target.id === req.userId) {
      await reply.code(400).send({ error: { code: 'cannot_add_self', message: '不能添加自己为好友' } });
      return;
    }
    const existing = await db.query<FriendshipRow>(
      `SELECT * FROM friendships
       WHERE (requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1)`,
      [req.userId, target.id],
    );
    const row = existing.rows[0];
    if (row?.status === 'accepted') {
      await reply.code(409).send({ error: { code: 'already_friends', message: '你们已经是好友了' } });
      return;
    }
    const base = httpBaseOf(req.headers);

    // 对方此前申请过我 → 我这次的申请等价于同意
    if (row && row.requester_id === target.id && row.status === 'pending') {
      await db.query("UPDATE friendships SET status = 'accepted', updated_at = now() WHERE id = $1", [row.id]);
      const me = (
        await db.query<UserRow>('SELECT id, username, avatar_url, bio FROM users WHERE id = $1', [req.userId!])
      ).rows[0]!;
      sendToUser(target.id, {
        type: 'friend:accepted',
        // online 让对方端无需额外查询即可正确显示在线状态
        payload: { user: { ...publicUserOf(base, me), online: onlineUserIds().has(me.id) } },
      });
      await reply.send({ request: { id: row.id, status: 'accepted', user: publicUserOf(base, target) } });
      return;
    }
    if (row) {
      await reply.code(409).send({ error: { code: 'request_pending', message: '好友申请已发送，等待对方处理' } });
      return;
    }

    const inserted = await db.query<FriendshipRow>(
      "INSERT INTO friendships (requester_id, addressee_id) VALUES ($1, $2) RETURNING *",
      [req.userId, target.id],
    );
    sendToUser(target.id, {
      type: 'friend:request',
      payload: {
        requestId: inserted.rows[0].id,
        from: publicUserOf(base, (await db.query<UserRow>('SELECT id, username, avatar_url, bio FROM users WHERE id = $1', [req.userId!])).rows[0]!),
      },
    });
    await reply.code(201).send({ request: { id: inserted.rows[0].id, status: 'pending', user: publicUserOf(base, target) } });
  });

  // 好友申请列表（收到的 / 我发出的）
  app.get('/api/friends/requests', { preHandler: [auth] }, async (req, reply) => {
    const incoming = await db.query<FriendshipRow & UserRow>(
      `SELECT f.id, f.created_at, u.id AS uid, u.username, u.avatar_url, u.bio
       FROM friendships f JOIN users u ON u.id = f.requester_id
       WHERE f.addressee_id = $1 AND f.status = 'pending'
       ORDER BY f.created_at DESC`,
      [req.userId],
    );
    const outgoing = await db.query<FriendshipRow & UserRow>(
      `SELECT f.id, f.created_at, u.id AS uid, u.username, u.avatar_url, u.bio
       FROM friendships f JOIN users u ON u.id = f.addressee_id
       WHERE f.requester_id = $1 AND f.status = 'pending'
       ORDER BY f.created_at DESC`,
      [req.userId],
    );
    const base = httpBaseOf(req.headers);
    const shape = (r: Record<string, unknown>) => ({
      id: r.id as string,
      createdAt: r.created_at as string,
      user: publicUserOf(base, { id: r.uid as string, username: r.username as string, avatar_url: r.avatar_url as string | null, bio: r.bio as string | null }),
    });
    await reply.send({ incoming: incoming.rows.map(shape), outgoing: outgoing.rows.map(shape) });
  });

  // 同意好友申请（仅收件人可操作）
  app.post('/api/friends/requests/:id/accept', { preHandler: [auth] }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const found = await db.query<FriendshipRow>('SELECT * FROM friendships WHERE id = $1', [id]);
    const row = found.rows[0];
    if (!row || row.addressee_id !== req.userId) {
      await reply.code(404).send({ error: { code: 'request_not_found', message: '好友申请不存在或已处理' } });
      return;
    }
    if (row.status !== 'accepted') {
      await db.query("UPDATE friendships SET status = 'accepted', updated_at = now() WHERE id = $1", [id]);
    }
    const me = (
      await db.query<UserRow>('SELECT id, username, avatar_url, bio FROM users WHERE id = $1', [req.userId!])
    ).rows[0]!;
    const other = (
      await db.query<UserRow>('SELECT id, username, avatar_url, bio FROM users WHERE id = $1', [row.requester_id])
    ).rows[0];
    const base = httpBaseOf(req.headers);
    // 通知申请人：已通过（online 让对方端直接显示正确在线状态）
    if (other) sendToUser(row.requester_id, { type: 'friend:accepted', payload: { user: { ...publicUserOf(base, me), online: onlineUserIds().has(me.id) } } });
    await reply.send({ friend: other ? { ...publicUserOf(base, other), online: onlineUserIds().has(other.id) } : null });
  });

  // 拒绝好友申请（删除记录，可重新申请）
  app.post('/api/friends/requests/:id/decline', { preHandler: [auth] }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const found = await db.query<FriendshipRow>('SELECT * FROM friendships WHERE id = $1', [id]);
    const row = found.rows[0];
    if (!row || row.addressee_id !== req.userId) {
      await reply.code(404).send({ error: { code: 'request_not_found', message: '好友申请不存在或已处理' } });
      return;
    }
    await db.query('DELETE FROM friendships WHERE id = $1', [id]);
    sendToUser(row.requester_id, { type: 'friend:declined', payload: { userId: req.userId! } });
    await reply.send({ ok: true });
  });

  // 删除好友（任一方向均可发起，双向生效）
  app.post('/api/friends/:userId/remove', { preHandler: [auth] }, async (req, reply) => {
    const otherId = (req.params as { userId: string }).userId;
    const found = await db.query<FriendshipRow>(
      `SELECT * FROM friendships
       WHERE status = 'accepted'
         AND ((requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1))`,
      [req.userId, otherId],
    );
    if (found.rows.length === 0) {
      await reply.code(404).send({ error: { code: 'not_friends', message: '你们不是好友' } });
      return;
    }
    await db.query('DELETE FROM friendships WHERE id = $1', [found.rows[0].id]);
    sendToUser(otherId, { type: 'friend:removed', payload: { userId: req.userId! } });
    await reply.send({ ok: true });
  });
}
