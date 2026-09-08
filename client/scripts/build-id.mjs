// 构建唯一标识：让每个构建都能被区分（版本号恒为 0.7.0，光看版本分不出包）。
// 形如 build.20260909.0231.a621819 —— 时间戳 + 短 git sha。
// 构建开始时生成并落盘到 client/.build-id，前端（vite define）与产物复制脚本读同一份，
// 保证同一次构建里「关于页显示的 ID」与「安装包文件名里的 ID」完全一致。
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)); // client/scripts
const clientDir = join(here, '..');
const idFile = join(clientDir, '.build-id');

function shortSha() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: clientDir, encoding: 'utf-8' }).trim();
  } catch {
    return 'nogit';
  }
}

function nowStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.${p(d.getHours())}${p(d.getMinutes())}`;
}

export function makeBuildId() {
  return `build.${nowStamp()}.${shortSha()}`;
}

/** fresh=true：强制生成新 ID（每次构建都不同）；否则复用已有的（dev 会话/产物复制阶段） */
export function resolveBuildId(fresh = false) {
  if (!fresh && existsSync(idFile)) {
    const cached = readFileSync(idFile, 'utf-8').trim();
    if (cached) return cached;
  }
  const id = makeBuildId();
  writeFileSync(idFile, `${id}\n`, 'utf-8');
  return id;
}

// CLI：node scripts/build-id.mjs [--fresh]（由 package.json 的 build 脚本调用）
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const fresh = process.argv.includes('--fresh');
  const id = resolveBuildId(fresh);
  console.log(`[build-id] ${id}`);
}
