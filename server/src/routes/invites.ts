import type { FastifyInstance } from 'fastify';
import type { QueryResultRow } from 'pg';
import type { Db } from '../db/db.js';
import type { JwtService } from '../lib/jwt.js';
import { generateInviteLinkCode } from '../lib/invite.js';
import { makeAuthPreHandler } from '../plugins/auth.js';
import { toPublicRoom, fetchRoomWithCount } from './rooms.js';

export interface InvitesDeps {
  db: Db;
  jwt: JwtService;
}

interface InviteRow extends QueryResultRow {
  id: string;
  room_id: string;
  code: string;
  created_by: string;
  inviter_name: string;
  expires_at: string | null;
  max_uses: number;
  used_count: number;
  created_at: string;
  room_name: string | null;
}

/** 邀请链接有效期上限：30 天（0/未传 = 永久，expires_at 存 NULL） */
const MAX_EXPIRES_HOURS = 24 * 30;
/** 单链接使用次数上限：0 = 不限 */
const MAX_USES_LIMIT = 500;

/** HTML 转义（房间名 / 邀请人是用户输入，落地页必须转义防注入） */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

export function registerInvitesRoutes(app: FastifyInstance, deps: InvitesDeps): void {
  const { db } = deps;
  const auth = makeAuthPreHandler(deps.jwt);

  // 创建邀请链接（房间成员均可创建：把朋友拉进房间是成员的日常诉求，不限于房主）
  app.post('/api/rooms/:id/invites', { preHandler: [auth] }, async (req, reply) => {
    const roomId = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as { expiresInHours?: unknown; maxUses?: unknown };

    const member = await db.query('SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2', [
      roomId,
      req.userId,
    ]);
    if (member.rows.length === 0) {
      await reply.code(403).send({ error: { code: 'forbidden', message: '你不在该房间中' } });
      return;
    }

    const rawHours = body.expiresInHours === undefined || body.expiresInHours === null ? 0 : Number(body.expiresInHours);
    if (!Number.isFinite(rawHours) || rawHours < 0 || rawHours > MAX_EXPIRES_HOURS) {
      await reply.code(400).send({
        error: { code: 'invalid_input', message: `有效期须在 0（永久）到 ${MAX_EXPIRES_HOURS} 小时之间` },
      });
      return;
    }
    const rawMaxUses = body.maxUses === undefined || body.maxUses === null ? 0 : Number(body.maxUses);
    if (!Number.isFinite(rawMaxUses) || rawMaxUses < 0 || rawMaxUses > MAX_USES_LIMIT) {
      await reply.code(400).send({ error: { code: 'invalid_input', message: `次数上限须在 0（不限）到 ${MAX_USES_LIMIT} 之间` } });
      return;
    }

    // code 冲突重试（16 位长码碰撞概率极低，防御性循环）
    let code = generateInviteLinkCode();
    for (let i = 0; i < 5; i++) {
      const dup = await db.query('SELECT 1 FROM invite_links WHERE code = $1', [code]);
      if (dup.rows.length === 0) break;
      code = generateInviteLinkCode();
    }

    const inserted = await db.query<InviteRow>(
      `INSERT INTO invite_links (room_id, code, created_by, expires_at, max_uses)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [
        roomId,
        code,
        req.userId,
        rawHours > 0 ? new Date(Date.now() + rawHours * 3_600_000) : null,
        Math.floor(rawMaxUses),
      ],
    );
    const row = inserted.rows[0];
    await reply.code(201).send({
      invite: {
        id: row.id,
        code: row.code,
        roomId: row.room_id,
        createdBy: row.created_by,
        expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
        maxUses: Number(row.max_uses),
        usedCount: Number(row.used_count),
      },
    });
  });

  // 本房间邀请链接列表（房主管理用；成员只看到自己创建的）
  app.get('/api/rooms/:id/invites', { preHandler: [auth] }, async (req, reply) => {
    const roomId = (req.params as { id: string }).id;
    const room = await fetchRoomWithCount(db, roomId);
    if (!room) {
      await reply.code(404).send({ error: { code: 'room_not_found', message: '房间不存在' } });
      return;
    }
    const isOwner = room.owner_id === req.userId;
    if (!isOwner) {
      const member = await db.query('SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2', [
        roomId,
        req.userId,
      ]);
      if (member.rows.length === 0) {
        await reply.code(403).send({ error: { code: 'forbidden', message: '你不在该房间中' } });
        return;
      }
    }
    const res = await db.query<InviteRow>(
      `SELECT il.*, u.username AS inviter_name
       FROM invite_links il JOIN users u ON u.id = il.created_by
       WHERE il.room_id = $1 ${isOwner ? '' : 'AND il.created_by = $2'}
       ORDER BY il.created_at DESC`,
      isOwner ? [roomId] : [roomId, req.userId],
    );
    await reply.send({
      invites: res.rows.map((r) => ({
        id: r.id,
        code: r.code,
        roomId: r.room_id,
        createdBy: r.created_by,
        inviterName: r.inviter_name,
        expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
        maxUses: Number(r.max_uses),
        usedCount: Number(r.used_count),
        revoked: false,
      })),
    });
  });

  // 吊销邀请链接：创建者本人或房主
  app.delete('/api/invites/:code', { preHandler: [auth] }, async (req, reply) => {
    const code = String((req.params as { code: string }).code ?? '');
    const found = await db.query<{ id: string; created_by: string; room_id: string }>(
      'SELECT id, created_by, room_id FROM invite_links WHERE code = $1',
      [code],
    );
    const invite = found.rows[0];
    if (!invite) {
      await reply.code(404).send({ error: { code: 'invite_not_found', message: '邀请链接不存在' } });
      return;
    }
    if (invite.created_by !== req.userId) {
      const owner = await db.query<{ owner_id: string }>('SELECT owner_id FROM rooms WHERE id = $1', [invite.room_id]);
      if (owner.rows.length === 0 || owner.rows[0].owner_id !== req.userId) {
        await reply.code(403).send({ error: { code: 'forbidden', message: '仅创建者或房主可以吊销' } });
        return;
      }
    }
    await db.query('DELETE FROM invite_links WHERE id = $1', [invite.id]);
    await reply.send({ ok: true });
  });

  // 邀请链接预览：加入前展示房间名/邀请人/剩余资格（已登录即可查）
  app.get('/api/invites/:code', { preHandler: [auth] }, async (req, reply) => {
    const code = String((req.params as { code: string }).code ?? '');
    const found = await db.query<InviteRow>(
      `SELECT il.*, u.username AS inviter_name, r.name AS room_name
       FROM invite_links il
       JOIN users u ON u.id = il.created_by
       JOIN rooms r ON r.id = il.room_id
       WHERE il.code = $1`,
      [code],
    );
    const invite = found.rows[0];
    if (!invite) {
      await reply.code(404).send({ error: { code: 'invite_not_found', message: '邀请链接不存在或已失效' } });
      return;
    }
    const expired = invite.expires_at !== null && new Date(invite.expires_at).getTime() < Date.now();
    const exhausted = Number(invite.max_uses) > 0 && Number(invite.used_count) >= Number(invite.max_uses);
    const joined = await db.query('SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2', [
      invite.room_id,
      req.userId,
    ]);
    await reply.send({
      invite: {
        code: invite.code,
        roomName: invite.room_name,
        inviterName: invite.inviter_name,
        expiresAt: invite.expires_at ? new Date(invite.expires_at).toISOString() : null,
        maxUses: Number(invite.max_uses),
        usedCount: Number(invite.used_count),
        valid: !expired && !exhausted,
        alreadyMember: joined.rows.length > 0,
      },
    });
  });

  // 使用邀请链接加入房间：校验资格 → 入房 → 计数（已是成员则幂等不计数）
  app.post('/api/invites/:code/redeem', { preHandler: [auth] }, async (req, reply) => {
    const code = String((req.params as { code: string }).code ?? '');
    const found = await db.query<InviteRow>(
      `SELECT il.*, r.name AS room_name
       FROM invite_links il JOIN rooms r ON r.id = il.room_id
       WHERE il.code = $1`,
      [code],
    );
    const invite = found.rows[0];
    if (!invite) {
      await reply.code(404).send({ error: { code: 'invite_not_found', message: '邀请链接不存在或已失效' } });
      return;
    }
    if (invite.expires_at !== null && new Date(invite.expires_at).getTime() < Date.now()) {
      await reply.code(410).send({ error: { code: 'invite_expired', message: '邀请链接已过期' } });
      return;
    }
    if (Number(invite.max_uses) > 0 && Number(invite.used_count) >= Number(invite.max_uses)) {
      await reply.code(410).send({ error: { code: 'invite_exhausted', message: '邀请链接使用次数已达上限' } });
      return;
    }
    const joined = await db.query('SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2', [
      invite.room_id,
      req.userId,
    ]);
    if (joined.rows.length === 0) {
      await db.query('INSERT INTO room_members (room_id, user_id) VALUES ($1, $2)', [invite.room_id, req.userId]);
      await db.query('UPDATE invite_links SET used_count = used_count + 1 WHERE id = $1', [invite.id]);
    }
    const full = await fetchRoomWithCount(db, invite.room_id);
    await reply.send({ room: toPublicRoom(full!) });
  });

  // 公网邀请落地页：给没装客户端的朋友（浏览器直接打开，无需登录）。
  // 页面提供 gametalk:// 深链（已装用户一键进房）与客户端下载入口；信息仅房间名与邀请人。
  app.get('/i/:code', async (req, reply) => {
    const code = String((req.params as { code: string }).code ?? '');
    const found = await db.query<{ room_name: string; inviter_name: string; expires_at: string | null; max_uses: number; used_count: number }>(
      `SELECT r.name AS room_name, u.username AS inviter_name, il.expires_at, il.max_uses, il.used_count
       FROM invite_links il
       JOIN rooms r ON r.id = il.room_id
       JOIN users u ON u.id = il.created_by
       WHERE il.code = $1`,
      [code],
    );
    const inv = found.rows[0];
    const expired = !!inv && inv.expires_at !== null && new Date(inv.expires_at).getTime() < Date.now();
    const exhausted = !!inv && inv.max_uses > 0 && Number(inv.used_count) >= Number(inv.max_uses);
    const dead = !inv || expired || exhausted;
    const reason = !inv ? '链接不存在或已被吊销' : expired ? '链接已过期' : '链接使用次数已达上限';
    const roomName = inv ? escapeHtml(inv.room_name) : '';
    const inviterName = inv ? escapeHtml(inv.inviter_name) : '';
    const deepLink = `gametalk://join?code=${encodeURIComponent(code)}`;
    const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>GameTalk 邀请</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#151821;font-family:system-ui,-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;color:#e8eaf2}
.card{max-width:360px;width:calc(100% - 48px);background:#1e222c;border-radius:16px;padding:36px 28px;text-align:center}
.room{font-size:22px;font-weight:700;margin:10px 0 4px;word-break:break-all}
.sub{color:#8b93a7;font-size:13px;margin-bottom:28px}
a.btn{display:block;padding:13px 0;border-radius:10px;text-decoration:none;font-size:15px;margin-top:12px}
.primary{background:#3370ff;color:#fff;font-weight:600}
.ghost{border:1px solid #3a4050;color:#aeb6c8}
.dead{color:#8b93a7;font-size:14px;line-height:1.7}
</style>
</head>
<body><div class="card">
<div style="font-size:34px">🎮</div>
${inv ? `<div class="room">「${roomName}」</div>
<div class="sub">${inviterName} 邀请你加入 GameTalk 房间</div>
<a class="btn primary" href="${deepLink}">已安装 GameTalk？点此加入房间</a>
<a class="btn ghost" href="https://github.com/aocac/GameTalk/releases/latest" target="_blank" rel="noopener">下载 GameTalk 客户端</a>` : `<div class="dead">${reason}</div>`}
</div></body></html>`;
    await reply.type('text/html; charset=utf-8').send(html);
  });
}
