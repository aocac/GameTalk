import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createDb, type Db } from '../src/db/db.js';
import { runMigrations } from '../src/db/migrate.js';
import { loadConfig } from '../src/config.js';
import { createJwtService } from '../src/lib/jwt.js';
import { mintTurnCredential } from '../src/routes/turn.js';

const TURN_SECRET = 'test-turn-secret';
const TURN_URL = 'turn:turnhost.example:3478,turn:turnhost.example:3478?transport=tcp';

let app: FastifyInstance;
let db: Db;

async function registerUser(username: string, a: FastifyInstance): Promise<{ token: string; userId: string }> {
  const res = await a.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username, password: 'password123' },
  });
  const body = res.json();
  return { token: body.token, userId: body.user.id };
}

beforeAll(async () => {
  db = createDb(loadConfig({ NODE_ENV: 'test' }));
  await runMigrations(db);
  const jwt = createJwtService('test-secret', '1h');
  app = await buildApp({ config: loadConfig({ NODE_ENV: 'test', TURN_SECRET, TURN_URL }), db, jwt });
  await app.listen({ host: '127.0.0.1', port: 0 });
});

afterAll(async () => {
  await app.close();
  await db.close();
});

describe('turn credentials endpoint', () => {
  it('requires auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/turn' });
    expect(res.statusCode).toBe(401);
  });

  it('mints time-limited HMAC credentials bound to the requesting user', async () => {
    const { token, userId } = await registerUser('turn_a', app);
    const res = await app.inject({ method: 'GET', url: '/api/turn', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    const { iceServers } = res.json();
    expect(iceServers).toHaveLength(1);
    const [server] = iceServers;
    expect(server.urls).toEqual(['turn:turnhost.example:3478', 'turn:turnhost.example:3478?transport=tcp']);
    // username = '<到期时间戳>:<userId>'，credential = base64(hmac-sha1(secret, username))
    const [expiry, boundUser] = String(server.username).split(':');
    expect(boundUser).toBe(userId);
    expect(Number(expiry)).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(server.credential).toBe(
      crypto.createHmac('sha1', TURN_SECRET).update(String(server.username)).digest('base64'),
    );
    // 与导出的 mint 函数一致
    expect(mintTurnCredential(TURN_SECRET, userId).credential).toBe(
      crypto.createHmac('sha1', TURN_SECRET).update(mintTurnCredential(TURN_SECRET, userId).username).digest('base64'),
    );
  });

  it('returns empty iceServers when TURN is not configured', async () => {
    const jwt = createJwtService('test-secret', '1h');
    const plain = await buildApp({ config: loadConfig({ NODE_ENV: 'test' }), db, jwt });
    try {
      const { token } = await registerUser('turn_b', plain);
      const res = await plain.inject({ method: 'GET', url: '/api/turn', headers: { authorization: `Bearer ${token}` } });
      expect(res.statusCode).toBe(200);
      expect(res.json().iceServers).toEqual([]);
    } finally {
      await plain.close();
    }
  });
});
