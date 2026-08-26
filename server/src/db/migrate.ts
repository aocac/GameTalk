import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './db.js';

// 迁移文件位于包根目录 server/migrations/：
// - 开发（tsx 从 src/ 运行）：../.. 指向 server/
// - 生产（node 从 dist/ 运行）：../.. 同样指向 server/（dist 与 src 同级）
const defaultMigrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

/**
 * 按文件名顺序执行未应用的 *.sql migration，并记录到 _migrations 表。
 * 生产（pg）与开发（PGlite）同源执行。
 */
export async function runMigrations(db: Db, dir: string = defaultMigrationsDir): Promise<string[]> {
  await db.exec(
    'CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())',
  );
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const appliedRows = await db.query<{ name: string }>('SELECT name FROM _migrations');
  const applied = new Set(appliedRows.rows.map((r) => r.name));

  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(dir, file), 'utf8');
    await db.exec(sql);
    await db.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
    ran.push(file);
  }
  return ran;
}
