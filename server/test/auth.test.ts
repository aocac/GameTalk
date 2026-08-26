import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createDb, type Db } from '../src/db/db.js';
import { runMigrations } from '../src/db/migrate.js';
import { loadConfig } from '../src/config.js';
import { createJwtService } from '../src/lib/jwt.js';

let app: FastifyInstance;
let db: Db;

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

describe('auth', () => {
  it('registers a new user', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'gamer_one', password: 'password123' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.token).toBeTruthy();
    expect(body.user.username).toBe('gamer_one');
    expect(body.user.id).toBeTruthy();
    expect(body.user.password_hash).toBeUndefined();
  });

  it('rejects short username and short password', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'ab', password: 'password123' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_input');

    const res2 = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'valid_name', password: 'short' },
    });
    expect(res2.statusCode).toBe(400);
  });

  it('rejects duplicate username', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'dup_user', password: 'password123' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'dup_user', password: 'password123' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('username_taken');
  });

  it('logs in with correct password', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'login_user', password: 'password123' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'login_user', password: 'password123' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().token).toBeTruthy();
  });

  it('rejects wrong password', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'login_user', password: 'wrong-password' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('bad_credentials');
  });

  it('GET /api/auth/me requires token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(res.statusCode).toBe(401);
  });

  it('GET /api/auth/me returns current user', async () => {
    const reg = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'me_user', password: 'password123' },
    });
    const { token } = reg.json();
    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.username).toBe('me_user');
  });

  it('PATCH /api/auth/me updates username and avatar', async () => {
    const reg = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'patch_user', password: 'password123' },
    });
    const { token } = reg.json();

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${token}` },
      payload: { username: 'patched_name', avatarUrl: 'https://example.com/a.png' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.username).toBe('patched_name');
    expect(res.json().user.avatarUrl).toBe('https://example.com/a.png');

    // 清空头像
    const res2 = await app.inject({
      method: 'PATCH',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${token}` },
      payload: { avatarUrl: '' },
    });
    expect(res2.json().user.avatarUrl).toBe('');
  });

  it('rejects duplicate rename', async () => {
    const reg = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'rename_a', password: 'password123' },
    });
    const { token } = reg.json();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${token}` },
      payload: { username: 'dup_user' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('uploads avatar via data URL', async () => {
    const reg = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'avatar_user', password: 'password123' },
    });
    const { token } = reg.json();

    // 1x1 透明 PNG
    const pngBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/avatar',
      headers: { authorization: `Bearer ${token}` },
      payload: { dataUrl: `data:image/png;base64,${pngBase64}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.avatarUrl).toContain('data:image/png;base64,');
  });

  it('rejects non-image avatar payload', async () => {
    const reg = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'avatar_bad', password: 'password123' },
    });
    const { token } = reg.json();

    // 伪装成 png 的文本
    const fake = Buffer.from('not-an-image').toString('base64');
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/avatar',
      headers: { authorization: `Bearer ${token}` },
      payload: { dataUrl: `data:image/png;base64,${fake}` },
    });
    expect(res.statusCode).toBe(400);

    // 超大（>512KB）
    const huge = Buffer.alloc(600 * 1024, 0x89).toString('base64');
    const res2 = await app.inject({
      method: 'POST',
      url: '/api/auth/avatar',
      headers: { authorization: `Bearer ${token}` },
      payload: { dataUrl: `data:image/png;base64,${huge}` },
    });
    expect(res2.statusCode).toBe(400);
  });
});
