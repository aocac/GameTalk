import type { FastifyInstance } from 'fastify';
import type { QueryResultRow } from 'pg';
import type { Db } from '../db/db.js';
import type { JwtService } from '../lib/jwt.js';
import { MAX_IMAGE_BYTES, validateImageDataUrl } from '../lib/image.js';
import { makeAuthPreHandler } from '../plugins/auth.js';

export interface MediaDeps {
  db: Db;
  jwt: JwtService;
}

interface MediaRow extends QueryResultRow {
  id: string;
  mime: string;
  bytes: Buffer;
}

const MEDIA_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 消息图片存储路径（存入 messages.media_url 的规范形式） */
export function mediaPathOf(id: string): string {
  return `/api/media/${id}`;
}

export function registerMediaRoutes(app: FastifyInstance, deps: MediaDeps): void {
  const { db } = deps;
  const auth = makeAuthPreHandler(deps.jwt);

  // 图片上传：dataUrl → media 表（bodyLimit 覆盖 5MB 图的 base64 体积 ≈ 6.7MB）
  app.post(
    '/api/media',
    { preHandler: [auth], bodyLimit: 8 * 1024 * 1024, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = (req.body ?? {}) as { dataUrl?: unknown };
      const result = validateImageDataUrl(body.dataUrl, MAX_IMAGE_BYTES);
      if (!result.ok) {
        const msg =
          result.error === 'image_too_large'
            ? '图片需 ≤5MB，请换一张更小的图'
            : '图片格式不支持（仅 PNG/JPEG/WebP/GIF）';
        await reply.code(400).send({ error: { code: result.error ?? 'invalid_media', message: msg } });
        return;
      }
      const inserted = await db.query<{ id: string }>(
        'INSERT INTO media (owner_id, mime, bytes) VALUES ($1, $2, $3) RETURNING id',
        [req.userId, result.mime, result.bytes],
      );
      await reply.code(201).send({ id: inserted.rows[0].id, url: mediaPathOf(inserted.rows[0].id) });
    },
  );

  // 图片读取：免认证（与头像端点同策略——id 为不可枚举 UUID，防遍历）。
  // 必须免认证：<img> 标签无法附带 Authorization 头，强制登录会导致消息里全部裂图。
  app.get('/api/media/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!MEDIA_ID_RE.test(id)) {
      await reply.code(404).send();
      return;
    }
    const found = await db.query<MediaRow>('SELECT mime, bytes FROM media WHERE id = $1', [id]);
    const row = found.rows[0];
    if (!row) {
      await reply.code(404).send();
      return;
    }
    await reply.header('content-type', row.mime).header('cache-control', 'public, max-age=31536000, immutable').send(row.bytes);
  });
}
