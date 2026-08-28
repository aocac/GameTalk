import type { FastifyInstance } from 'fastify';
import type { QueryResultRow } from 'pg';
import type { Config } from '../config.js';
import type { Db } from '../db/db.js';
import type { JwtService } from '../lib/jwt.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { validateAvatarDataUrl } from '../lib/image.js';
import { avatarHttpUrlOf, httpBaseOf } from '../lib/avatar.js';
import { makeAuthPreHandler } from '../plugins/auth.js';

export interface AuthDeps {
  config: Config;
  db: Db;
  jwt: JwtService;
}

export interface PublicUser {
  id: string;
  username: string;
  avatarUrl: string | null;
  bio: string | null;
  createdAt: string;
}

interface UserRow extends QueryResultRow {
  id: string;
  username: string;
  password_hash: string;
  avatar_url: string | null;
  bio: string | null;
  created_at: string;
}

function toPublicUser(u: UserRow, httpBase: string): PublicUser {
  return {
    id: u.id,
    username: u.username,
    avatarUrl: avatarHttpUrlOf(httpBase, u.id, u.avatar_url),
    bio: u.bio ?? null,
    createdAt: u.created_at,
  };
}

const USERNAME_RE = /^[\w\u4e00-\u9fa5-]{3,24}$/;

function validateCredentials(username: string, password: string): string | null {
  if (!USERNAME_RE.test(username)) {
    return '用户名需为 3-24 位字母、数字、下划线、中文或连字符';
  }
  if (password.length < 8 || password.length > 72) {
    return '密码长度需在 8-72 位之间';
  }
  return null;
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthDeps): void {
  const { db, jwt, config } = deps;
  const auth = makeAuthPreHandler(jwt);
  // 认证类路由加严限流（防爆破/批量注册）；全局默认限流见 app.ts
  const strictLimit = { config: { rateLimit: { max: config.authRateLimitMax, timeWindow: '1 minute' } } };

  // 头像端点（公开但 id 为不可枚举的 UUID）：把 data URL 从广播/消息流里解耦出去
  app.get('/api/avatars/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      await reply.code(404).send();
      return;
    }
    const found = await db.query<{ avatar_url: string | null }>('SELECT avatar_url FROM users WHERE id = $1', [id]);
    const stored = found.rows[0]?.avatar_url;
    const m = stored ? /^data:([^;]+);base64,(.+)$/s.exec(stored) : null;
    if (!m) {
      await reply.code(404).send();
      return;
    }
    await reply
      .header('content-type', m[1])
      .header('cache-control', 'public, max-age=300')
      .send(Buffer.from(m[2], 'base64'));
  });

  app.post('/api/auth/register', strictLimit, async (req, reply) => {
    const body = (req.body ?? {}) as { username?: unknown; password?: unknown };
    const username = String(body.username ?? '').trim();
    const password = String(body.password ?? '');
    const err = validateCredentials(username, password);
    if (err) {
      await reply.code(400).send({ error: { code: 'invalid_input', message: err } });
      return;
    }

    const existing = await db.query<UserRow>('SELECT id FROM users WHERE username = $1', [username]);
    if (existing.rows.length > 0) {
      await reply.code(409).send({ error: { code: 'username_taken', message: '用户名已被占用' } });
      return;
    }

    const passwordHash = await hashPassword(password);
    let inserted;
    try {
      inserted = await db.query<UserRow>(
        'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING *',
        [username, passwordHash],
      );
    } catch (err) {
      // check-then-insert 存在并发竞态，用户名唯一索引兜底（23505 = unique_violation）
      if ((err as { code?: string }).code === '23505') {
        await reply.code(409).send({ error: { code: 'username_taken', message: '用户名已被占用' } });
        return;
      }
      throw err;
    }
    const user = inserted.rows[0];
    const token = await jwt.sign({ sub: user.id, username: user.username });
    await reply.code(201).send({ token, user: toPublicUser(user, httpBaseOf(req.headers)) });
  });

  app.post('/api/auth/login', strictLimit, async (req, reply) => {
    const body = (req.body ?? {}) as { username?: unknown; password?: unknown };
    const username = String(body.username ?? '').trim();
    const password = String(body.password ?? '');

    const found = await db.query<UserRow>('SELECT * FROM users WHERE username = $1', [username]);
    const user = found.rows[0];
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      await reply.code(401).send({ error: { code: 'bad_credentials', message: '用户名或密码错误' } });
      return;
    }
    const token = await jwt.sign({ sub: user.id, username: user.username });
    await reply.send({ token, user: toPublicUser(user, httpBaseOf(req.headers)) });
  });

  app.get('/api/auth/me', { preHandler: [auth] }, async (req, reply) => {
    const found = await db.query<UserRow>('SELECT * FROM users WHERE id = $1', [req.userId]);
    const user = found.rows[0];
    if (!user) {
      await reply.code(404).send({ error: { code: 'user_not_found', message: '用户不存在' } });
      return;
    }
    await reply.send({ user: toPublicUser(user, httpBaseOf(req.headers)) });
  });

  // 头像上传：接收 data URL，服务端校验类型/大小/魔数后入库
  // bodyLimit：3MB 图片的 base64 ≈ 4MB，需覆盖默认 1MB
  app.post(
    '/api/auth/avatar',
    { preHandler: [auth], bodyLimit: 5 * 1024 * 1024, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = (req.body ?? {}) as { dataUrl?: unknown };
      const result = validateAvatarDataUrl(body.dataUrl);
      if (!result.ok) {
        await reply.code(400).send({ error: { code: result.error, message: '头像格式不支持（仅 PNG/JPEG/WebP/GIF，且 ≤3MB）' } });
        return;
      }
      const updated = await db.query<UserRow>(
        'UPDATE users SET avatar_url = $1, updated_at = now() WHERE id = $2 RETURNING *',
        [result.dataUrl, req.userId],
      );
      const user = updated.rows[0];
      if (!user) {
        await reply.code(404).send({ error: { code: 'user_not_found', message: '用户不存在' } });
        return;
      }
      await reply.send({ user: toPublicUser(user, httpBaseOf(req.headers)) });
    },
  );

  // 用户公开资料（成员卡片用）：需登录，id 为不可枚举 UUID
  app.get('/api/users/:id', { preHandler: [auth] }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      await reply.code(404).send({ error: { code: 'user_not_found', message: '用户不存在' } });
      return;
    }
    const found = await db.query<UserRow>(
      'SELECT id, username, avatar_url, bio, created_at FROM users WHERE id = $1',
      [id],
    );
    const u = found.rows[0];
    if (!u) {
      await reply.code(404).send({ error: { code: 'user_not_found', message: '用户不存在' } });
      return;
    }
    const base = httpBaseOf(req.headers);
    await reply.send({
      user: {
        id: u.id,
        username: u.username,
        bio: u.bio ?? null,
        avatarUrl: avatarHttpUrlOf(base, u.id, u.avatar_url),
        createdAt: u.created_at,
      },
    });
  });

  app.patch('/api/auth/me', { preHandler: [auth] }, async (req, reply) => {
    const body = (req.body ?? {}) as { username?: unknown; avatarUrl?: unknown; bio?: unknown };
    const username = body.username === undefined ? undefined : String(body.username).trim();
    const avatarUrl = body.avatarUrl === undefined ? undefined : String(body.avatarUrl).trim().slice(0, 500);
    const bio = body.bio === undefined ? undefined : String(body.bio).trim().slice(0, 100) || null;

    if (username !== undefined) {
      if (!USERNAME_RE.test(username)) {
        await reply.code(400).send({ error: { code: 'invalid_input', message: '用户名需为 3-24 位字母、数字、下划线、中文或连字符' } });
        return;
      }
      const dup = await db.query<UserRow>('SELECT id FROM users WHERE username = $1 AND id <> $2', [username, req.userId]);
      if (dup.rows.length > 0) {
        await reply.code(409).send({ error: { code: 'username_taken', message: '用户名已被占用' } });
        return;
      }
    }

    // 动态构建 SET：undefined = 不修改；null/字符串 = 显式设置（可用于清空头像/签名）
    const sets: string[] = [];
    const params: unknown[] = [];
    if (username !== undefined) {
      params.push(username);
      sets.push(`username = $${params.length}`);
    }
    if (avatarUrl !== undefined) {
      params.push(avatarUrl);
      sets.push(`avatar_url = $${params.length}`);
    }
    if (bio !== undefined) {
      params.push(bio);
      sets.push(`bio = $${params.length}`);
    }
    if (sets.length === 0) {
      const current = await db.query<UserRow>('SELECT * FROM users WHERE id = $1', [req.userId]);
      const u = current.rows[0];
      if (!u) {
        await reply.code(404).send({ error: { code: 'user_not_found', message: '用户不存在' } });
        return;
      }
      await reply.send({ user: toPublicUser(u, httpBaseOf(req.headers)) });
      return;
    }
    params.push(req.userId);
    sets.push('updated_at = now()');
    const updated = await db.query<UserRow>(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params,
    );
    const user = updated.rows[0];
    if (!user) {
      await reply.code(404).send({ error: { code: 'user_not_found', message: '用户不存在' } });
      return;
    }
    await reply.send({ user: toPublicUser(user, httpBaseOf(req.headers)) });
  });
}
