/**
 * 环境变量加载：Node 22 内置 process.loadEnvFile。
 * .env 不存在时静默忽略（开发模式零配置启动）。
 */
export function loadEnvFileIfPresent(path = '.env'): void {
  try {
    process.loadEnvFile?.(path);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e?.code !== 'ENOENT') throw err;
  }
}
