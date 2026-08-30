import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createDb, type Db } from '../src/db/db.js';
import { runMigrations } from '../src/db/migrate.js';
import { loadConfig } from '../src/config.js';
import { createJwtService } from '../src/lib/jwt.js';

let app: FastifyInstance;
let db: Db;

async function registerUser(username: string): Promise<{ token: string; userId: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username, password: 'password123' },
  });
  const body = res.json();
  return { token: body.token, userId: body.user.id };
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

/** 上传一张 1x1 PNG，返回 mediaId */
async function uploadMedia(token: string): Promise<string> {
  const png =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const res = await app.inject({ method: 'POST', url: '/api/media', headers: auth(token), payload: { dataUrl: png } });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

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

describe('personal stickers', () => {
  it('add / list / dedupe / delete, ownership enforced', async () => {
    const a = await registerUser('stk_a');
    const b = await registerUser('stk_b');
    const mediaId = await uploadMedia(a.token);

    // 他人媒体不可添加为自己的表情
    const stolen = await app.inject({
      method: 'POST',
      url: '/api/stickers',
      headers: auth(b.token),
      payload: { mediaId },
    });
    expect(stolen.statusCode).toBe(404);

    // 添加 → 列表可见
    const add = await app.inject({ method: 'POST', url: '/api/stickers', headers: auth(a.token), payload: { mediaId } });
    expect(add.statusCode).toBe(201);
    expect(add.json().sticker.url).toContain(mediaId);

    // 重复添加幂等（仍只有一个）
    await app.inject({ method: 'POST', url: '/api/stickers', headers: auth(a.token), payload: { mediaId } });
    const list = await app.inject({ method: 'GET', url: '/api/stickers', headers: auth(a.token) });
    expect(list.json().stickers).toHaveLength(1);

    // 删除
    const stickerId = add.json().sticker.id as string;
    const delB = await app.inject({ method: 'DELETE', url: `/api/stickers/${stickerId}`, headers: auth(b.token) });
    expect(delB.statusCode).toBe(404); // 他人不可删
    const del = await app.inject({ method: 'DELETE', url: `/api/stickers/${stickerId}`, headers: auth(a.token) });
    expect(del.statusCode).toBe(200);
    const after = await app.inject({ method: 'GET', url: '/api/stickers', headers: auth(a.token) });
    expect(after.json().stickers).toHaveLength(0);
  });

  it('enforces the 24-sticker cap', async () => {
    const a = await registerUser('stk_cap');
    let last = 0;
    for (let i = 0; i < 25; i++) {
      const mediaId = await uploadMedia(a.token);
      last = (
        await app.inject({ method: 'POST', url: '/api/stickers', headers: auth(a.token), payload: { mediaId } })
      ).statusCode;
    }
    expect(last).toBe(409);
  });
});

describe('room stickers', () => {
  it('members contribute and see shared stickers; non-members denied; owner or adder can remove', async () => {
    const owner = await registerUser('stk_room_owner');
    const member = await registerUser('stk_room_member');
    const outsider = await registerUser('stk_room_out');
    const room = (
      await app.inject({ method: 'POST', url: '/api/rooms', headers: auth(owner.token), payload: { name: '表情房' } })
    ).json().room;
    await app.inject({
      method: 'POST',
      url: '/api/rooms/join',
      headers: auth(member.token),
      payload: { inviteCode: room.inviteCode },
    });

    // 非成员读写都被拒
    const denyList = await app.inject({ method: 'GET', url: `/api/rooms/${room.id}/stickers`, headers: auth(outsider.token) });
    expect(denyList.statusCode).toBe(403);
    const denyAdd = await app.inject({
      method: 'POST',
      url: `/api/rooms/${room.id}/stickers`,
      headers: auth(outsider.token),
      payload: { mediaId: '00000000-0000-4000-8000-000000000001' },
    });
    expect(denyAdd.statusCode).toBe(403);

    // 成员添加两张（各自上传）
    const m1 = await uploadMedia(member.token);
    const m2 = await uploadMedia(owner.token);
    const add1 = await app.inject({
      method: 'POST',
      url: `/api/rooms/${room.id}/stickers`,
      headers: auth(member.token),
      payload: { mediaId: m1 },
    });
    expect(add1.statusCode).toBe(201);
    expect(add1.json().sticker.addedByUsername).toBe('stk_room_member');
    await app.inject({
      method: 'POST',
      url: `/api/rooms/${room.id}/stickers`,
      headers: auth(owner.token),
      payload: { mediaId: m2 },
    });

    // 成员可见（全群共享）
    const list = await app.inject({ method: 'GET', url: `/api/rooms/${room.id}/stickers`, headers: auth(member.token) });
    expect(list.json().stickers).toHaveLength(2);

    // 房主可删成员加的；成员不可删房主加的
    const s1 = add1.json().sticker.id as string;
    const delByMember = await app.inject({
      method: 'DELETE',
      url: `/api/rooms/${room.id}/stickers/${s1}`,
      headers: auth(member.token),
    });
    expect(delByMember.statusCode).toBe(200); // 添加者本人可删
    const after = await app.inject({ method: 'GET', url: `/api/rooms/${room.id}/stickers`, headers: auth(member.token) });
    expect(after.json().stickers).toHaveLength(1);

    // 重复添加同一媒体幂等
    await app.inject({
      method: 'POST',
      url: `/api/rooms/${room.id}/stickers`,
      headers: auth(owner.token),
      payload: { mediaId: m2 },
    });
    const dedup = await app.inject({ method: 'GET', url: `/api/rooms/${room.id}/stickers`, headers: auth(owner.token) });
    expect(dedup.json().stickers).toHaveLength(1);
  });
});
