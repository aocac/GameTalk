import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import type { Config } from './config.js';
import type { Db } from './db/db.js';
import type { JwtService } from './lib/jwt.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerAuthRoutes } from './routes/auth.js';
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
  });

  await app.register(cors, { origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(',') });
  await app.register(websocket);

  registerHealthRoutes(app, { db });
  registerAuthRoutes(app, { config, db, jwt });
  registerWsRoutes(app, { config, db, jwt });

  return app;
}
