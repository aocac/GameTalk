// GameTalk 第二客户端（浏览器）启动器
// 启动前端 dev server，就绪后自动打开浏览器 http://localhost:1420
// 用法：仓库根目录双击 second-client.cmd
import { spawn, execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)); // client/scripts
const clientDir = join(here, '..');
const PORT = 1420;

console.log('================================================');
console.log('  GameTalk 第二客户端（浏览器）');
console.log('  就绪后自动打开 http://localhost:1420');
console.log('================================================');
console.log();

const vite = spawn('npm', ['run', 'dev'], { cwd: clientDir, stdio: 'inherit', shell: process.platform === 'win32' });

async function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://localhost:${port}`);
      if (r.ok) return true;
    } catch {
      // 尚未就绪
    }
    await new Promise((res) => setTimeout(res, 500));
  }
  return false;
}

if (await waitForPort(PORT, 30000)) {
  console.log(`[GameTalk] 第二客户端已就绪：http://localhost:${PORT}`);
  console.log('[GameTalk] 注册新账号或用邀请码加入房间即可双端聊天。');
  execSync(`start http://localhost:${PORT}`, { shell: true });
} else {
  console.error(`[GameTalk] 前端启动超时，请手动打开 http://localhost:${PORT}`);
}

vite.on('close', (code) => process.exit(code ?? 0));
