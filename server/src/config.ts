export interface Config {
  host: string;
  port: number;
  /** 设置了则为真实 PostgreSQL；null 时使用 PGlite（开发/测试） */
  databaseUrl: string | null;
  /** PGlite 数据目录（相对服务端运行目录）；测试模式传空使用内存库 */
  pgliteDataDir: string;
  jwtSecret: string;
  jwtExpiresIn: string;
  corsOrigin: string;
  logLevel: string;
  nodeEnv: string;
  /** REST 全局限流：每 IP 每分钟最大请求数 */
  rateLimitMax: number;
  /** 认证类路由（注册/登录）每 IP 每分钟最大请求数（防爆破） */
  authRateLimitMax: number;
  /** TURN 中继共享密钥（coturn use-auth-secret 模式）；未设置时 /api/turn 返回空 iceServers */
  turnSecret: string | null;
  /** TURN 地址（逗号分隔，如 turn:host:3478,turn:host:3478?transport=tcp） */
  turnUrls: string[];
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
    pgliteDataDir: env.PGLITE_DATA_DIR || 'data/gametalk.pglite',
    jwtSecret,
    jwtExpiresIn: env.JWT_EXPIRES_IN || '7d',
    corsOrigin: env.CORS_ORIGIN || '*',
    logLevel: env.LOG_LEVEL || 'info',
    nodeEnv: env.NODE_ENV || 'development',
    rateLimitMax: parseInt(env.RATE_LIMIT_MAX || '300', 10),
    // 测试模式放开认证限流（测试套件会大量注册/登录）；生产默认 10 次/分钟
    authRateLimitMax: env.NODE_ENV === 'test' ? 1_000_000 : parseInt(env.RATE_LIMIT_AUTH_MAX || '10', 10),
    turnSecret: env.TURN_SECRET || null,
    turnUrls: env.TURN_URL ? env.TURN_URL.split(',').map((s) => s.trim()).filter(Boolean) : [],
  };
}
