import type { FastifyInstance } from 'fastify';
import type { QueryResultRow } from 'pg';
import type { Db } from '../db/db.js';
import type { JwtService } from '../lib/jwt.js';
import { httpBaseOf } from '../lib/avatar.js';
import { makeAuthPreHandler } from '../plugins/auth.js';

export interface StickersDeps {
  db: Db;
  jwt: JwtService;
}

/** 个人表情包与群共享表情库的统一上限 */
export const MAX_STICKERS = 24;

interface StickerRow extends QueryResultRow {
  id: string;
  media_id: string;
  added_by: string;
  added_by_username: string | null;
  created_at: string;
}

function toSticker(base: string, r: StickerRow) {
  return {
    id: r.id,
    mediaId: r.media_id,
    url: `${base}/api/media/${r.media_id}`,
    addedBy: r.added_by,
    addedByUsername: r.added_by_username ?? '',
    createdAt: r.created_at,
  };
}

const MEDIA_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function registerStickersRoutes(app: FastifyInstance, deps: StickersDeps): void {
  const { db } = deps;
  const auth = makeAuthPreHandler(deps.jwt);

  // ============ 个人表情包（跨设备同步） ============

  app.get('/api/stickers', { preHandler: [auth] }, async (req, reply) => {
    const res = await db.query<StickerRow>(
      `SELECT s.id, s.media_id, s.owner_id AS added_by, u.username AS added_by_username, s.created_at
       FROM user_stickers s JOIN users u ON u.id = s.owner_id
       WHERE s.owner_id = $1
       ORDER BY s.created_at ASC`,
      [req.userId],
    );
    const base = httpBaseOf(req.headers);
    await reply.send({ stickers: res.rows.map((r) => toSticker(base, r)), max: MAX_STICKERS });
  });

  app.post('/api/stickers', { preHandler: [auth] }, async (req, reply) => {
    const body = (req.body ?? {}) as { mediaId?: unknown };
    const mediaId = String(body.mediaId ?? '');
    if (!MEDIA_ID_RE.test(mediaId)) {
      await reply.code(400).send({ error: { code: 'invalid_input', message: 'invalid media id' } });
      return;
    }
    // 媒体必须存在且属于本人（防引用他人媒体）
    const owned = await db.query('SELECT 1 FROM media WHERE id = $1 AND owner_id = $2', [mediaId, req.userId]);
    if (owned.rows.length === 0) {
      await reply.code(404).send({ error: { code: 'media_not_found', message: '图片不存在或不属于你' } });
      return;
    }
    const count = await db.query<{ c: string }>('SELECT COUNT(*)::text AS c FROM user_stickers WHERE owner_id = $1', [
      req.userId,
    ]);
    if (Number(count.rows[0].c) >= MAX_STICKERS) {
      await reply.code(409).send({ error: { code: 'too_many_stickers', message: `表情包最多 ${MAX_STICKERS} 个` } });
      return;
    }
    const inserted = await db.query<StickerRow>(
      `INSERT INTO user_stickers (owner_id, media_id) VALUES ($1, $2)
       ON CONFLICT (owner_id, media_id) DO UPDATE SET created_at = now()
       RETURNING id, media_id, owner_id AS added_by, NULL::text AS added_by_username, created_at`,
      [req.userId, mediaId],
    );
    const base = httpBaseOf(req.headers);
    await reply.code(201).send({ sticker: toSticker(base, inserted.rows[0]) });
  });

  app.delete('/api/stickers/:id', { preHandler: [auth] }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!MEDIA_ID_RE.test(id)) {
      await reply.code(404).send({ error: { code: 'sticker_not_found', message: '表情不存在' } });
      return;
    }
    const res = await db.query('DELETE FROM user_stickers WHERE id = $1 AND owner_id = $2', [id, req.userId]);
    if (res.rowCount === 0) {
      await reply.code(404).send({ error: { code: 'sticker_not_found', message: '表情不存在' } });
      return;
    }
    await reply.send({ ok: true });
  });

  // ============ 群共享表情库（成员共同贡献，全群可见） ============

  async function assertRoomMember(roomId: string, userId: string): Promise<boolean> {
    const res = await db.query('SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2', [roomId, userId]);
    return res.rows.length > 0;
  }

  app.get('/api/rooms/:id/stickers', { preHandler: [auth] }, async (req, reply) => {
    const roomId = (req.params as { id: string }).id;
    if (!MEDIA_ID_RE.test(roomId) || !(await assertRoomMember(roomId, req.userId!))) {
      await reply.code(403).send({ error: { code: 'forbidden', message: '仅房间成员可以查看群表情' } });
      return;
    }
    const res = await db.query<StickerRow>(
      `SELECT s.id, s.media_id, s.added_by, u.username AS added_by_username, s.created_at
       FROM room_stickers s JOIN users u ON u.id = s.added_by
       WHERE s.room_id = $1
       ORDER BY s.created_at ASC`,
      [roomId],
    );
    const base = httpBaseOf(req.headers);
    await reply.send({ stickers: res.rows.map((r) => toSticker(base, r)), max: MAX_STICKERS });
  });

  app.post('/api/rooms/:id/stickers', { preHandler: [auth] }, async (req, reply) => {
    const roomId = (req.params as { id: string }).id;
    if (!MEDIA_ID_RE.test(roomId) || !(await assertRoomMember(roomId, req.userId!))) {
      await reply.code(403).send({ error: { code: 'forbidden', message: '仅房间成员可以添加群表情' } });
      return;
    }
    const body = (req.body ?? {}) as { mediaId?: unknown };
    const mediaId = String(body.mediaId ?? '');
    if (!MEDIA_ID_RE.test(mediaId)) {
      await reply.code(400).send({ error: { code: 'invalid_input', message: 'invalid media id' } });
      return;
    }
    const count = await db.query<{ c: string }>('SELECT COUNT(*)::text AS c FROM room_stickers WHERE room_id = $1', [
      roomId,
    ]);
    if (Number(count.rows[0].c) >= MAX_STICKERS) {
      await reply.code(409).send({ error: { code: 'too_many_stickers', message: `群表情最多 ${MAX_STICKERS} 个` } });
      return;
    }
    const inserted = await db.query<StickerRow>(
      `INSERT INTO room_stickers (room_id, media_id, added_by) VALUES ($1, $2, $3)
       ON CONFLICT (room_id, media_id) DO UPDATE SET created_at = now()
       RETURNING id, media_id, added_by, (SELECT username FROM users WHERE id = $3) AS added_by_username, created_at`,
      [roomId, mediaId, req.userId],
    );
    const base = httpBaseOf(req.headers);
    await reply.code(201).send({ sticker: toSticker(base, inserted.rows[0]) });
  });

  // 删除：添加者本人或房主
  app.delete('/api/rooms/:id/stickers/:stickerId', { preHandler: [auth] }, async (req, reply) => {
    const roomId = (req.params as { id: string }).id;
    const stickerId = (req.params as { stickerId: string }).stickerId;
    if (!MEDIA_ID_RE.test(roomId) || !MEDIA_ID_RE.test(stickerId) || !(await assertRoomMember(roomId, req.userId!))) {
      await reply.code(403).send({ error: { code: 'forbidden', message: '仅房间成员可以操作群表情' } });
      return;
    }
    const owner = await db.query<{ owner_id: string }>('SELECT owner_id FROM rooms WHERE id = $1', [roomId]);
    if (owner.rows.length === 0) {
      await reply.code(404).send({ error: { code: 'room_not_found', message: '房间不存在' } });
      return;
    }
    const res = await db.query(
      'DELETE FROM room_stickers WHERE id = $1 AND room_id = $2 AND (added_by = $3 OR $3 = $4)',
      [stickerId, roomId, req.userId, owner.rows[0].owner_id],
    );
    if (res.rowCount === 0) {
      await reply.code(404).send({ error: { code: 'sticker_not_found', message: '表情不存在或无权删除' } });
      return;
    }
    await reply.send({ ok: true });
  });
}
