import { loadEnvFileIfPresent } from '../lib/envfile.js';
loadEnvFileIfPresent();
import { loadConfig } from '../config.js';
import { createDb } from './db.js';
import { runMigrations } from './migrate.js';

const config = loadConfig();
const db = createDb(config);
try {
  const ran = await runMigrations(db);
  console.log(`[migrate] applied: ${ran.length ? ran.join(', ') : '(none pending)'}`);
} finally {
  await db.close();
}
