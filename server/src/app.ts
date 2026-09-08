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
import { registerTurnRoutes } from './routes/turn.js';
import { registerWsRoutes } from './ws/gateway.js';

export interface AppDeps {
  config: Config;
  db: Db;
  jwt: JwtService;
}

/** 回环/私网地址才视为可信反代（docker 内网里的 Caddy）；公网直连客户端不可伪造来源 */
export function isTrustedProxy(address: string | undefined): boolean {
  if (!address) return false;
  if (address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1') return true;
  if (/^10\./.test(address)) return true;
  if (/^192\.168\./.test(address)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) return true;
  return /^f[cd][0-9a-f]{2}:/i.test(address); // fc00::/7 唯一本地地址
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config, db, jwt } = deps;
  const app = Fastify({
    logger: { level: config.logLevel },
    disableRequestLogging: config.nodeEnv === 'production',
    // 只信任回环/私网来源的 X-Forwarded-For（compose 内网里的 Caddy 容器），
    // 公网直连客户端自带的 XFF 一律忽略——否则可伪造来源绕过登录/注册限流
    trustProxy: isTrustedProxy,
    // 用户在客户端填的服务器地址常带尾斜杠（如 http://ip:8787/），
    // 拼接后会出现 //api/... 双斜杠路径——默认会 404，这里统一容忍
    ignoreTrailingSlash: true,
    ignoreDuplicateSlashes: true,
  });

  // 统一错误出口：PG 入参/外键类错误不再变成 500（非法 id → 400，引用不存在 → 404）；
  // 限流等插件抛出的 {statusCode, error} 负载原样透出，保持客户端错误码契约
  app.setErrorHandler((err, req, reply) => {
    const e = err as { statusCode?: number; code?: string; error?: unknown; message?: string };
    if (e.error && typeof e.error === 'object') {
      reply.code(e.statusCode ?? 400).send({ error: e.error });
      return;
    }
    if (e.code === '22P02') {
      reply.code(400).send({ error: { code: 'invalid_input', message: '无效的 id 格式' } });
      return;
    }
    if (e.code === '23503') {
      reply.code(404).send({ error: { code: 'not_found', message: '关联资源不存在' } });
      return;
    }
    const status = e.statusCode ?? 500;
    if (status >= 500) req.log.error({ err }, 'request failed');
    reply
      .code(status)
      .send({ error: { code: status >= 500 ? 'internal_error' : (e.code ?? 'error'), message: status >= 500 ? '服务器内部错误' : (e.message ?? '请求失败') } });
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
  registerTurnRoutes(app, { config, jwt });
  registerWsRoutes(app, { config, db, jwt });

  return app;
}
