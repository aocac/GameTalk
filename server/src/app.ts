import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import type { Config } from './config.js';
import type { Db } from './db/db.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerWsRoutes } from './ws/gateway.js';

export interface AppDeps {
  config: Config;
  db: Db;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config, db } = deps;
  const app = Fastify({
    logger: { level: config.logLevel },
    // 生产环境关闭 Fastify 默认的敏感信息展示
    disableRequestLogging: config.nodeEnv === 'production',
  });

  await app.register(cors, { origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(',') });
  await app.register(websocket);

  registerHealthRoutes(app, { db });
  registerWsRoutes(app);

  return app;
}
