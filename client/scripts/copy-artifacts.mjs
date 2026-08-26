// tauri build 完成后把安装包复制到项目根目录，方便取用
// 由 tauri.conf.json 的 build.afterBuildCommand 调用
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)); // client/scripts
const root = join(here, '..', '..');
const bundleDir = join(here, '..', 'src-tauri', 'target', 'release', 'bundle', 'nsis');

const candidates = ['GameTalk_0.1.0_x64-setup.exe', 'GameTalk_0.1.0_x64_en-US.msi'];
const src = candidates.map((f) => join(bundleDir, f)).find((p) => existsSync(p));

if (!src) {
  console.warn('[copy-artifacts] 未找到安装包产物，跳过复制');
  process.exit(0);
}

const dst = join(root, 'GameTalk-Setup.exe');
copyFileSync(src, dst);
console.log(`[copy-artifacts] 已复制到项目根目录: ${dst}`);
