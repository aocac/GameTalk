import type { FastifyInstance } from 'fastify';
import type { QueryResultRow } from 'pg';
import type { Db } from '../db/db.js';
import type { JwtService } from '../lib/jwt.js';
import { generateInviteCode } from '../lib/invite.js';
import { makeAuthPreHandler } from '../plugins/auth.js';

export interface RoomsDeps {
  db: Db;
  jwt: JwtService;
}

interface RoomRow extends QueryResultRow {
  id: string;
  name: string;
  invite_code: string;
  owner_id: string;
  created_at: string;
  member_count: number;
}

interface MemberRow extends QueryResultRow {
  id: string;
  username: string;
  avatar_url: string | null;
}

interface MessageRow extends QueryResultRow {
  id: string;
  room_id: string;
  user_id: string;
  username: string;
  text: string;
  created_at: string;
}

export interface PublicRoom {
  id: string;
  name: string;
  inviteCode: string;
  ownerId: string;
  memberCount: number;
  createdAt: string;
}

export function toPublicRoom(r: RoomRow): PublicRoom {
  return {
    id: r.id,
    name: r.name,
    inviteCode: r.invite_code,
    ownerId: r.owner_id,
    memberCount: Number(r.member_count),
    createdAt: r.created_at,
  };
}

export async function isMember(db: Db, roomId: string, userId: string): Promise<boolean> {
  const res = await db.query('SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2', [roomId, userId]);
  return res.rows.length > 0;
}

async function fetchRoomWithCount(db: Db, roomId: string): Promise<RoomRow | null> {
  const res = await db.query<RoomRow>(
    `SELECT r.*, COUNT(rm.user_id)::int AS member_count
     FROM rooms r
     LEFT JOIN room_members rm ON rm.room_id = r.id
     WHERE r.id = $1
     GROUP BY r.id`,
    [roomId],
  );
  return res.rows[0] ?? null;
}

export function registerRoomsRoutes(app: FastifyInstance, deps: RoomsDeps): void {
  const { db } = deps;
  const auth = makeAuthPreHandler(deps.jwt);

  // 创建房间（创建者自动成为成员）
  app.post('/api/rooms', { preHandler: [auth] }, async (req, reply) => {
    const body = (req.body ?? {}) as { name?: unknown };
    const name = String(body.name ?? '').trim().slice(0, 40);
    if (!name) {
      await reply.code(400).send({ error: { code: 'invalid_input', message: '房间名不能为空' } });
      return;
    }

    // 生成唯一邀请码（冲突则重试）
    let inviteCode = generateInviteCode();
    for (let i = 0; i < 5; i++) {
      const dup = await db.query('SELECT id FROM rooms WHERE invite_code = $1', [inviteCode]);
      if (dup.rows.length === 0) break;
      inviteCode = generateInviteCode();
    }

    const created = await db.query<RoomRow>(
      'INSERT INTO rooms (name, invite_code, owner_id) VALUES ($1, $2, $3) RETURNING *',
      [name, inviteCode, req.userId],
    );
    const room = created.rows[0];
    await db.query('INSERT INTO room_members (room_id, user_id) VALUES ($1, $2)', [room.id, req.userId]);

    const full = await fetchRoomWithCount(db, room.id);
    await reply.code(201).send({ room: toPublicRoom(full!) });
  });

  // 我的房间列表
  app.get('/api/rooms', { preHandler: [auth] }, async (req, reply) => {
    const res = await db.query<RoomRow>(
      `SELECT r.*, COUNT(rm2.user_id)::int AS member_count
       FROM room_members rm
       JOIN rooms r ON r.id = rm.room_id
       LEFT JOIN room_members rm2 ON rm2.room_id = r.id
       WHERE rm.user_id = $1
       GROUP BY r.id
       ORDER BY r.created_at DESC`,
      [req.userId],
    );
    await reply.send({ rooms: res.rows.map(toPublicRoom) });
  });

  // 通过邀请码加入房间
  app.post('/api/rooms/join', { preHandler: [auth] }, async (req, reply) => {
    const body = (req.body ?? {}) as { inviteCode?: unknown };
    const inviteCode = String(body.inviteCode ?? '').trim().toUpperCase();
    if (!inviteCode) {
      await reply.code(400).send({ error: { code: 'invalid_input', message: '邀请码不能为空' } });
      return;
    }
    const found = await db.query<RoomRow>('SELECT * FROM rooms WHERE invite_code = $1', [inviteCode]);
    const room = found.rows[0];
    if (!room) {
      await reply.code(404).send({ error: { code: 'room_not_found', message: '邀请码无效或房间不存在' } });
      return;
    }
    if (!(await isMember(db, room.id, req.userId!))) {
      await db.query('INSERT INTO room_members (room_id, user_id) VALUES ($1, $2)', [room.id, req.userId]);
    }
    const full = await fetchRoomWithCount(db, room.id);
    await reply.send({ room: toPublicRoom(full!) });
  });

  // 房间详情 + 成员
  app.get('/api/rooms/:id', { preHandler: [auth] }, async (req, reply) => {
    const roomId = (req.params as { id: string }).id;
    const room = await fetchRoomWithCount(db, roomId);
    if (!room) {
      await reply.code(404).send({ error: { code: 'room_not_found', message: '房间不存在' } });
      return;
    }
    if (!(await isMember(db, roomId, req.userId!))) {
      await reply.code(403).send({ error: { code: 'forbidden', message: '你不在该房间中' } });
      return;
    }
    const members = await db.query<MemberRow>(
      `SELECT u.id, u.username, u.avatar_url
       FROM room_members rm JOIN users u ON u.id = rm.user_id
       WHERE rm.room_id = $1
       ORDER BY rm.joined_at ASC`,
      [roomId],
    );
    await reply.send({ room: toPublicRoom(room), members: members.rows });
  });

  // 消息历史（游标分页：before=消息id，返回该消息之前的最早 limit 条，按时间升序）
  app.get('/api/rooms/:id/messages', { preHandler: [auth] }, async (req, reply) => {
    const roomId = (req.params as { id: string }).id;
    const query = req.query as { before?: string; limit?: string };
    const before = query.before ? String(query.before) : null;
    const limit = Math.min(Math.max(parseInt(query.limit ?? '50', 10) || 50, 1), 100);

    if (!(await isMember(db, roomId, req.userId!))) {
      await reply.code(403).send({ error: { code: 'forbidden', message: '你不在该房间中' } });
      return;
    }

    const res = await db.query<MessageRow>(
      `SELECT * FROM (
         SELECT id, room_id, user_id, username, text, created_at
         FROM messages
         WHERE room_id = $1
           AND ($2::uuid IS NULL OR (created_at, id) < (SELECT created_at, id FROM messages WHERE id = $2))
         ORDER BY created_at DESC, id DESC
         LIMIT $3
       ) t
       ORDER BY created_at ASC, id ASC`,
      [roomId, before, limit + 1],
    );

    const rows = res.rows;
    const hasMore = rows.length > limit;
    const messages = (hasMore ? rows.slice(0, limit) : rows).map((m) => ({
      id: m.id,
      roomId: m.room_id,
      userId: m.user_id,
      username: m.username,
      text: m.text,
      createdAt: m.created_at,
    }));
    await reply.send({ messages, hasMore });
  });

  // 离开房间（房间空后删除）
  app.post('/api/rooms/:id/leave', { preHandler: [auth] }, async (req, reply) => {
    const roomId = (req.params as { id: string }).id;
    const room = await fetchRoomWithCount(db, roomId);
    if (!room) {
      await reply.code(404).send({ error: { code: 'room_not_found', message: '房间不存在' } });
      return;
    }
    await db.query('DELETE FROM room_members WHERE room_id = $1 AND user_id = $2', [roomId, req.userId]);
    const remaining = await db.query('SELECT COUNT(*)::int AS c FROM room_members WHERE room_id = $1', [roomId]);
    if (Number(remaining.rows[0].c) === 0) {
      await db.query('DELETE FROM rooms WHERE id = $1', [roomId]);
    }
    await reply.send({ ok: true });
  });
}
