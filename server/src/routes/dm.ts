import type { FastifyInstance } from 'fastify';
import type { QueryResultRow } from 'pg';
import type { Db } from '../db/db.js';
import type { JwtService } from '../lib/jwt.js';
import { avatarHttpUrlOf, httpBaseOf } from '../lib/avatar.js';
import { makeAuthPreHandler } from '../plugins/auth.js';

export interface DmDeps {
  db: Db;
  jwt: JwtService;
}

interface DmRow extends QueryResultRow {
  id: string;
  sender_id: string;
  recipient_id: string;
  username: string;
  avatar_url: string | null;
  text: string;
  kind: string;
  media_url: string | null;
  recalled: boolean;
  created_at: string;
  reply_to: string | null;
  reply_username: string | null;
  reply_text: string | null;
  reply_kind: string | null;
  reply_recalled: boolean;
}

interface ReplyRef {
  id: string;
  username: string;
  text: string;
  kind: 'text' | 'image';
}

/** DM 消息对外形状（广播与历史同构；from/to 表达会话方向，渲染字段与房间消息对齐） */
export interface PublicDmMessage {
  id: string;
  from: string;
  to: string;
  username: string;
  avatarUrl: string | null;
  text: string;
  createdAt: string;
  kind: 'text' | 'image';
  mediaUrl: string | null;
  reply?: ReplyRef;
  recalled: boolean;
}

function toPublicDm(base: string, m: DmRow): PublicDmMessage {
  return {
    id: m.id,
    from: m.sender_id,
    to: m.recipient_id,
    username: m.username,
    avatarUrl: avatarHttpUrlOf(base, m.sender_id, m.avatar_url),
    text: m.text,
    createdAt: m.created_at,
    kind: (m.kind === 'image' ? 'image' : 'text') as 'text' | 'image',
    mediaUrl: m.media_url ? `${base}${m.media_url}` : null,
    recalled: m.recalled ?? false,
    reply: m.reply_to
      ? {
          id: m.reply_to,
          username: m.reply_username ?? '',
          text: m.reply_recalled ? '消息已撤回' : String(m.reply_text ?? '').slice(0, 80),
          kind: (m.reply_kind === 'image' ? 'image' : 'text') as 'image' | 'text',
        }
      : undefined,
  };
}

/** 双向好友关系校验（accepted 才算好友） */
export async function areFriends(db: Db, a: string, b: string): Promise<boolean> {
  const res = await db.query(
    `SELECT 1 FROM friendships
     WHERE status = 'accepted'
       AND ((requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1))`,
    [a, b],
  );
  return res.rows.length > 0;
}

export function registerDmRoutes(app: FastifyInstance, deps: DmDeps): void {
  const { db } = deps;
  const auth = makeAuthPreHandler(deps.jwt);

  // 私聊会话列表：每个对话对象的最后一条消息（DISTINCT ON 聚合，一次查询代替 N 次 limit=1）
  app.get('/api/dm/conversations', { preHandler: [auth] }, async (req, reply) => {
    const res = await db.query<DmRow>(
      `SELECT DISTINCT ON (peer_id) *
       FROM (
         SELECT m.id, m.sender_id, m.recipient_id, m.username, u.avatar_url, m.text, m.kind, m.media_url, m.recalled, m.created_at,
                NULL::uuid AS reply_to, NULL::text AS reply_username, NULL::text AS reply_text, NULL::text AS reply_kind, NULL::boolean AS reply_recalled,
                CASE WHEN m.sender_id = $1 THEN m.recipient_id ELSE m.sender_id END AS peer_id
         FROM dm_messages m
         LEFT JOIN users u ON u.id = m.sender_id
         WHERE m.sender_id = $1 OR m.recipient_id = $1
         ORDER BY m.created_at DESC, m.id DESC
       ) t
       ORDER BY peer_id, created_at DESC`,
      [req.userId],
    );
    const base = httpBaseOf(req.headers);
    const conversations = res.rows
      .map((r) => ({ peerId: r.sender_id === req.userId ? r.recipient_id : r.sender_id, last: toPublicDm(base, r) }))
      .sort((a, b) => (a.last.createdAt < b.last.createdAt ? 1 : -1));
    await reply.send({ conversations });
  });

  // 私聊历史（游标分页，与房间消息一致：before=消息id，返回之前 limit 条按时间升序）
  app.get('/api/dm/:peerId/messages', { preHandler: [auth] }, async (req, reply) => {
    const peerId = (req.params as { peerId: string }).peerId;
    const query = req.query as { before?: string; limit?: string };
    const before = query.before ? String(query.before) : null;
    const limit = Math.min(Math.max(parseInt(query.limit ?? '50', 10) || 50, 1), 100);

    if (!(await areFriends(db, req.userId!, peerId))) {
      await reply.code(403).send({ error: { code: 'forbidden', message: '仅好友之间可以私聊' } });
      return;
    }

    const res = await db.query<DmRow>(
      `SELECT * FROM (
         SELECT m.id, m.sender_id, m.recipient_id, m.username, u.avatar_url, m.text, m.kind, m.media_url, m.recalled, m.created_at,
                m.reply_to, r.username AS reply_username, r.text AS reply_text, r.kind AS reply_kind, r.recalled AS reply_recalled
         FROM dm_messages m
         LEFT JOIN users u ON u.id = m.sender_id
         LEFT JOIN dm_messages r ON r.id = m.reply_to
         WHERE ((m.sender_id = $1 AND m.recipient_id = $2) OR (m.sender_id = $2 AND m.recipient_id = $1))
           AND ($3::uuid IS NULL OR (m.created_at, m.id) < (SELECT created_at, id FROM dm_messages WHERE id = $3))
         ORDER BY m.created_at DESC, m.id DESC
         LIMIT $4
       ) t
       ORDER BY created_at ASC, id ASC`,
      [req.userId, peerId, before, limit + 1],
    );

    const rows = res.rows;
    const hasMore = rows.length > limit;
    const base = httpBaseOf(req.headers);
    await reply.send({ messages: (hasMore ? rows.slice(0, limit) : rows).map((m) => toPublicDm(base, m)), hasMore });
  });
}
