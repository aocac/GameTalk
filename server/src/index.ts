import { loadEnvFileIfPresent } from './lib/envfile.js';
loadEnvFileIfPresent();
import { loadConfig } from './config.js';
import { createDb } from './db/db.js';
import { runMigrations } from './db/migrate.js';
import { buildApp } from './app.js';

const config = loadConfig();
const db = createDb(config);
const migrated = await runMigrations(db);
if (migrated.length > 0) {
  console.log(`[boot] migrations applied: ${migrated.join(', ')}`);
}

const app = await buildApp({ config, db });

try {
  await app.listen({ host: config.host, port: config.port });
  app.log.info(`GameTalk server listening on ${config.host}:${config.port} (db: ${config.databaseUrl ? 'postgres' : 'pglite'})`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// 优雅关闭
const shutdown = async (signal: string) => {
  app.log.info(`received ${signal}, shutting down`);
  await app.close();
  await db.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
