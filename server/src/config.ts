export interface Config {
  host: string;
  port: number;
  /** 设置了则为真实 PostgreSQL；null 时使用 PGlite（开发/测试） */
  databaseUrl: string | null;
  jwtSecret: string;
  jwtExpiresIn: string;
  corsOrigin: string;
  logLevel: string;
  nodeEnv: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const jwtSecret = env.JWT_SECRET || 'dev-insecure-secret-change-me';
  if (env.NODE_ENV === 'production' && (!env.JWT_SECRET || jwtSecret.startsWith('dev-'))) {
    throw new Error('JWT_SECRET must be set (non-dev value) in production');
  }
  return {
    host: env.HOST || '0.0.0.0',
    port: parseInt(env.PORT || '8787', 10),
    databaseUrl: env.DATABASE_URL || null,
    jwtSecret,
    jwtExpiresIn: env.JWT_EXPIRES_IN || '7d',
    corsOrigin: env.CORS_ORIGIN || '*',
    logLevel: env.LOG_LEVEL || 'info',
    nodeEnv: env.NODE_ENV || 'development',
  };
}
