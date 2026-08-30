import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import type { Config } from './config.js';
import type { Db } from './db/db.js';
import type { JwtService } from './lib/jwt.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerRoomsRoutes } from './routes/rooms.js';
import { registerInvitesRoutes } from './routes/invites.js';
import { registerFriendsRoutes } from './routes/friends.js';
import { registerDmRoutes } from './routes/dm.js';
import { registerStickersRoutes } from './routes/stickers.js';
import { registerMediaRoutes } from './routes/media.js';
import { registerWsRoutes } from './ws/gateway.js';

export interface AppDeps {
  config: Config;
  db: Db;
  jwt: JwtService;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config, db, jwt } = deps;
  const app = Fastify({
    logger: { level: config.logLevel },
    disableRequestLogging: config.nodeEnv === 'production',
    // 信任反代头：compose 中仅 Caddy 能通过 127.0.0.1:8787 访问本服务，
    // 按 X-Forwarded-For 取真实客户端 IP 做限流（不设则所有人共享 Caddy 的 IP，一个桶全服限流）
    trustProxy: true,
    // 用户在客户端填的服务器地址常带尾斜杠（如 http://ip:8787/），
    // 拼接后会出现 //api/... 双斜杠路径——默认会 404，这里统一容忍
    ignoreTrailingSlash: true,
    ignoreDuplicateSlashes: true,
  });

  await app.register(cors, { origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(',') });
  // 无 body 的 POST（Content-Type: application/json 但 body 为空，如「接受好友/离开房间」）
  // Fastify 5 默认 400 FST_ERR_CTP_EMPTY_JSON_BODY —— 宽容为空对象，老客户端同样受益
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (body === '' || body === undefined) {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(body as string));
    } catch (e) {
      done(e as Error);
    }
  });
  // maxPayload：拒绝超大 WS 帧（合法消息 ≤2000 字符 + JWT，64KB 上限足够宽裕），防滥用
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });
  // REST 全局限流；认证类路由在 routes/auth.ts 内单独加严
  await app.register(rateLimit, {
    global: true,
    max: config.rateLimitMax,
    timeWindow: '1 minute',
    errorResponseBuilder: (_req, ctx) => ({
      // 插件会把返回值作为 error 抛出，HTTP 状态码取自 statusCode 属性
      statusCode: 429,
      error: { code: 'rate_limited', message: `请求过于频繁，请 ${ctx.after} 再试` },
    }),
  });

  registerHealthRoutes(app, { db });
  registerAuthRoutes(app, { config, db, jwt });
  registerRoomsRoutes(app, { db, jwt });
  registerInvitesRoutes(app, { db, jwt });
  registerFriendsRoutes(app, { db, jwt });
  registerDmRoutes(app, { db, jwt });
  registerStickersRoutes(app, { db, jwt });
  registerMediaRoutes(app, { db, jwt });
  registerWsRoutes(app, { config, db, jwt });

  return app;
}
