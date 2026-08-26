// GameTalk 第二客户端（浏览器）启动器
// 启动前端 dev server，就绪后自动打开浏览器 http://localhost:1420
// 用法：仓库根目录双击 second-client.cmd
// 若端口已在运行（重复双击/残留窗口）：直接打开浏览器，不重复启动
import { spawn, execSync } from 'node:child_process';
import net from 'node:net';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)); // dev/
const clientDir = join(here, '..', 'client');
const PORT = 1420;

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

console.log('================================================');
console.log('  GameTalk 第二客户端（浏览器）');
console.log(`  就绪后自动打开 http://localhost:${PORT}`);
console.log('================================================');
console.log();

if (await portInUse(PORT)) {
  console.log(`[GameTalk] 端口 ${PORT} 已在运行，直接打开浏览器。`);
  console.log('[GameTalk] 若无法访问，请关闭旧的第二客户端窗口后重试。');
  execSync(`start http://localhost:${PORT}`, { shell: true });
  process.exit(0);
}

// 用 shell 执行完整命令字符串（非 args 数组）：
// - 无 EINVAL（Windows 下 spawn 无法直接执行 .cmd，需 shell 解析）
// - 无 DEP0190 警告（该警告仅针对 shell:true + args 数组组合）
const vite = spawn('npm run dev', { cwd: clientDir, stdio: 'inherit', shell: true });

if (await waitForPort(PORT, 30000)) {
  console.log(`[GameTalk] 第二客户端已就绪：http://localhost:${PORT}`);
  console.log('[GameTalk] 注册新账号或用邀请码加入房间即可双端聊天。');
  execSync(`start http://localhost:${PORT}`, { shell: true });
} else {
  console.error(`[GameTalk] 前端启动超时，请手动打开 http://localhost:${PORT}`);
}

vite.on('close', (code) => process.exit(code ?? 0));
