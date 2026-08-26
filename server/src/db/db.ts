import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Pool, type QueryResultRow } from 'pg';
import { PGlite } from '@electric-sql/pglite';
import type { Config } from '../config.js';

export interface QueryResult<T extends QueryResultRow = QueryResultRow> {
  rows: T[];
  rowCount: number | null;
}

/**
 * 数据库抽象：生产（pg Pool）与开发测试（PGlite）共用同一接口，
 * 保证 migration 与业务 SQL 同源。
 */
export interface Db {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<T>>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

function makePgDb(url: string): Db {
  const pool = new Pool({ connectionString: url, max: 10 });
  return {
    async query<T extends QueryResultRow>(
      text: string,
      params: unknown[] = [],
    ): Promise<QueryResult<T>> {
      const r = await pool.query<T>(text, params as never[]);
      return { rows: r.rows, rowCount: r.rowCount };
    },
    async exec(sql: string): Promise<void> {
      await pool.query(sql);
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}

function makePgliteDb(dataDir?: string): Db {
  // 文件模式：确保目录存在（PGlite 不会自动创建）
  if (dataDir) {
    mkdirSync(dirname(dataDir), { recursive: true });
  }
  const pg = new PGlite(dataDir);
  return {
    async query<T extends QueryResultRow>(text: string, params: unknown[] = []): Promise<QueryResult<T>> {
      const r = await pg.query<T>(text, params);
      return { rows: r.rows, rowCount: (r.affectedRows ?? null) as number | null };
    },
    async exec(sql: string): Promise<void> {
      await pg.exec(sql);
    },
    async close(): Promise<void> {
      await pg.close();
    },
  };
}

export function createDb(config: Config): Db {
  if (config.databaseUrl) return makePgDb(config.databaseUrl);
  // 测试用内存库（数据不持久）；开发/本地模式持久化到 data 目录
  return makePgliteDb(config.nodeEnv === 'test' ? undefined : config.pgliteDataDir);
}
