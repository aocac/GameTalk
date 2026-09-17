import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createDb, type Db } from '../src/db/db.js';
import { runMigrations } from '../src/db/migrate.js';
import { loadConfig } from '../src/config.js';
import { createJwtService } from '../src/lib/jwt.js';
import { mediaPathOf, mediaUsageOf, sweepUnusedMedia } from '../src/lib/mediaLifecycle.js';

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const QUOTA = 8 * 1024; // 8KB：够几张 1×1 PNG，SQL 塞满后再测拒绝

let app: FastifyInstance;
let db: Db;

async function registerUser(username: string): Promise<{ token: string; userId: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username, password: 'password123' },
  });
  return { token: res.json().token, userId: res.json().user.id };
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function upload(token: string) {
  return app.inject({
    method: 'POST',
    url: '/api/media',
    headers: { ...auth(token), 'content-type': 'application/json' },
    payload: { dataUrl: PNG },
  });
}

beforeAll(async () => {
  db = createDb(loadConfig({ NODE_ENV: 'test' }));
  await runMigrations(db);
  const jwt = createJwtService('test-secret', '1h');
  app = await buildApp({
    config: loadConfig({
      NODE_ENV: 'test',
      MEDIA_QUOTA_BYTES: String(QUOTA),
      MEDIA_UNUSED_TTL_DAYS: '0',
    }),
    db,
    jwt,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
});

afterAll(async () => {
  await app.close();
  await db.close();
});

describe('media quota', () => {
  it('rejects upload when the user is over quota; other users are unaffected', async () => {
    const a = await registerUser('mq_a');
    const b = await registerUser('mq_b');

    const first = await upload(a.token);
    expect(first.statusCode).toBe(201);
    expect(await mediaUsageOf(db, a.userId)).toBeGreaterThan(0);

    await db.query('INSERT INTO media (owner_id, mime, bytes) VALUES ($1, $2, $3)', [
      a.userId,
      'image/png',
      Buffer.alloc(QUOTA),
    ]);
    const over = await upload(a.token);
    expect(over.statusCode).toBe(413);
    expect(over.json().error.code).toBe('quota_exceeded');
    expect(over.json().error.message).toMatch(/上限/);

    const other = await upload(b.token);
    expect(other.statusCode).toBe(201);
  });
});

describe('unused media TTL sweep', () => {
  it('deletes unreferenced old media, keeps stickers and message attachments, then quota frees up', async () => {
    const u = await registerUser('mq_ttl');

    const dangling = await upload(u.token);
    expect(dangling.statusCode).toBe(201);
    const danglingId = dangling.json().id as string;

    const stickerUp = await upload(u.token);
    expect(stickerUp.statusCode).toBe(201);
    const stickerMediaId = stickerUp.json().id as string;
    const addSticker = await app.inject({
      method: 'POST',
      url: '/api/stickers',
      headers: auth(u.token),
      payload: { mediaId: stickerMediaId },
    });
    expect(addSticker.statusCode).toBe(201);

    const room = (
      await app.inject({ method: 'POST', url: '/api/rooms', headers: auth(u.token), payload: { name: 'TTL房' } })
    ).json().room;
    const attached = await upload(u.token);
    expect(attached.statusCode).toBe(201);
    const attachedId = attached.json().id as string;
    await db.query(
      `INSERT INTO messages (room_id, user_id, username, text, kind, media_url)
       VALUES ($1, $2, $3, '', 'image', $4)`,
      [room.id, u.userId, 'mq_ttl', mediaPathOf(attachedId)],
    );

    await db.query('UPDATE media SET created_at = now() - interval \'30 days\' WHERE owner_id = $1', [u.userId]);
    const removed = await sweepUnusedMedia(db, new Date());
    expect(removed).toBeGreaterThanOrEqual(1);

    expect((await app.inject({ method: 'GET', url: `/api/media/${danglingId}` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/media/${stickerMediaId}` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/media/${attachedId}` })).statusCode).toBe(200);

    const recalled = await upload(u.token);
    expect(recalled.statusCode).toBe(201);
    const recalledId = recalled.json().id as string;
    await db.query(
      `INSERT INTO messages (room_id, user_id, username, text, kind, media_url, media_urls)
       VALUES ($1, $2, $3, '', 'image', $4, $5::jsonb)`,
      [room.id, u.userId, 'mq_ttl', mediaPathOf(recalledId), JSON.stringify([mediaPathOf(recalledId)])],
    );
    await db.query('UPDATE messages SET media_url = NULL, media_urls = NULL WHERE media_url = $1', [
      mediaPathOf(recalledId),
    ]);
    await db.query('UPDATE media SET created_at = now() - interval \'30 days\' WHERE id = $1', [recalledId]);
    await sweepUnusedMedia(db, new Date());
    expect((await app.inject({ method: 'GET', url: `/api/media/${recalledId}` })).statusCode).toBe(404);
  });
});
