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
  });

  await app.register(cors, { origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(',') });
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
  registerWsRoutes(app, { config, db, jwt });

  return app;
}
