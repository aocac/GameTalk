import type { FastifyInstance } from 'fastify';
import { createRequire } from 'node:module';
import type { Db } from '../db/db.js';

// src/routes/ 与 dist/routes/ 向上两级都是 server 包根，package.json 两条路径一致解析；
// Docker 镜像需 COPY package.json（见 server.Dockerfile）
const require = createRequire(import.meta.url);
const { version } = require('../../package.json') as { version: string };

export function registerHealthRoutes(app: FastifyInstance, deps: { db: Db }): void {
  app.get('/health', async () => {
    await deps.db.query('SELECT 1');
    return {
      status: 'ok',
      service: 'gametalk-server',
      version,
      time: new Date().toISOString(),
    };
  });
}
