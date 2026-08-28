// tauri build 完成后把安装包复制到项目根目录，方便取用。
// 保留版本号与架构信息（不简化文件名），如 GameTalk-0.1.0-x64-Setup.exe
import { copyFileSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)); // client/scripts
const root = join(here, '..', '..');
const bundleDir = join(here, '..', 'src-tauri', 'target', 'release', 'bundle', 'nsis');

// 从 tauri.conf.json 读版本号，避免硬编码
let version = '0.0.0';
try {
  const conf = JSON.parse(
    readFileSync(join(here, '..', 'src-tauri', 'tauri.conf.json'), 'utf-8'),
  );
  version = conf.version ?? version;
} catch {
  // 读取失败则沿用默认
}

// 找到实际产物（_x64_ / _arm64_ 由文件名自动识别）。
// bundle 目录可能残留旧版本产物（readdir 顺序不保证最新在前），优先精确匹配当前版本，
// 否则取修改时间最新的一份——否则会把旧安装包当成新构建复制出去。
function isBundled(f) {
  return /-setup\.exe$/i.test(f) || /\.msi$/i.test(f);
}
const candidates = existsSync(bundleDir) ? readdirSync(bundleDir).filter(isBundled) : [];
const byVersion = candidates.find((f) => f.includes(version));
const newest = [...candidates].sort(
  (a, b) => statSync(join(bundleDir, b)).mtimeMs - statSync(join(bundleDir, a)).mtimeMs,
)[0];
const picked = byVersion ?? newest;
const src = picked ? join(bundleDir, picked) : undefined;

if (!src) {
  console.warn('[copy-artifacts] 未找到安装包产物，跳过复制');
  process.exit(0);
}

// GameTalk_0.1.0_x64-setup.exe -> arch=x64
const archMatch = basename(src).match(/_(x64|arm64|aarch64|universal)_/i);
const arch = archMatch ? archMatch[1].toLowerCase() : 'x64';
const isMsi = /\.msi$/i.test(src);
const ext = isMsi ? 'msi' : 'Setup';

const dst = join(root, `GameTalk-${version}-${arch}-${ext}${isMsi ? '' : '.exe'}`);
copyFileSync(src, dst);
console.log(`[copy-artifacts] 已复制到项目根目录: ${dst}`);
