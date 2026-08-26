import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/db.js';

export function registerHealthRoutes(app: FastifyInstance, deps: { db: Db }): void {
  app.get('/health', async () => {
    await deps.db.query('SELECT 1');
    return {
      status: 'ok',
      service: 'gametalk-server',
      version: '0.1.0',
      time: new Date().toISOString(),
    };
  });
}
