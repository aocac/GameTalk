// tauri build 完成后把安装包复制到项目根目录，方便取用。
// 保留版本号与架构信息（不简化文件名），如 GameTalk-0.1.0-x64-Setup.exe
import { copyFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
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

// 找到实际产物（_x64_ / _arm64_ 由文件名自动识别）
const files = existsSync(bundleDir)
  ? readdirSync(bundleDir).filter((f) => /\.(exe|msi)$/i.test(f))
  : [];
const src = files
  .map((f) => join(bundleDir, f))
  .find((p) => /-setup\.exe$/i.test(p) || /\.msi$/i.test(p));

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
