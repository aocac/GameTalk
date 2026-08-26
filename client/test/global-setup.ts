import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

export const TEST_PORT = 18787;
export const TEST_WS_URL = `ws://127.0.0.1:${TEST_PORT}/ws`;
export const TEST_HTTP_URL = `http://127.0.0.1:${TEST_PORT}`;

let server: ChildProcess | null = null;

export async function setup(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const serverDir = join(here, '..', '..', 'server');
  const entry = join(serverDir, 'dist', 'index.js');

  server = spawn(process.execPath, [entry], {
    cwd: serverDir,
    env: { ...process.env, PORT: String(TEST_PORT), NODE_ENV: 'test', HOST: '127.0.0.1' },
    stdio: 'ignore',
  });

  // 等待健康检查就绪（最多 15s）
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${TEST_HTTP_URL}/health`);
      if (res.ok) return;
    } catch {
      // server 尚未就绪
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('GameTalk test server failed to start');
}

export async function teardown(): Promise<void> {
  if (server) {
    server.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    server = null;
  }
}
