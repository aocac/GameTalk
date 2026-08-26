// GameTalk 本地服务器启动器（替代 .bat：UTF-8 无编码坑，逻辑可测试）
// 用法：仓库根目录双击 start-local.cmd，或手动执行 node server/scripts/start-local.mjs
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)); // server/scripts
const serverDir = join(here, '..');
const PORT = 8787;

function run(cmd, args, cwd) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, stdio: 'inherit' });
    p.on('close', (code) => resolve(code ?? 0));
  });
}

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    s.on('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.on('error', () => resolve(false));
  });
}

console.log('================================================');
console.log('  GameTalk 本地服务器启动器');
console.log('  数据持久化于 server\\data\\ 目录');
console.log('================================================');
console.log();

if (!existsSync(join(serverDir, 'node_modules'))) {
  console.log('[GameTalk] 首次运行：正在安装服务端依赖（约 1 分钟）...');
  const c = await run(npmCmd, ['install'], serverDir);
  if (c !== 0) {
    console.error('[GameTalk] 依赖安装失败，请检查上方错误。');
    process.exit(c);
  }
}

if (!existsSync(join(serverDir, 'dist'))) {
  console.log('[GameTalk] 首次运行：正在构建服务端...');
  const c = await run(npmCmd, ['run', 'build'], serverDir);
  if (c !== 0) {
    console.error('[GameTalk] 构建失败，请检查上方错误。');
    process.exit(c);
  }
}

if (await portInUse(PORT)) {
  console.log(`[GameTalk] 端口 ${PORT} 已被占用（可能服务器已在运行）。`);
  console.log('          若提示无法连接，请先关闭旧的服务器窗口后重试。');
  process.exit(0);
}

console.log(`[GameTalk] 本地服务器已启动：http://127.0.0.1:${PORT}`);
console.log('[GameTalk] 保持本窗口开启；Ctrl+C 或关闭窗口即停止服务器。');
console.log();

const code = await run(process.execPath, ['dist/index.js'], serverDir);
process.exit(code ?? 0);
