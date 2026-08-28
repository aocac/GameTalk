// 服务器主人专用：重置指定用户的密码（无需邮箱/找回流程）
// 用法：cd server && npm run reset-password -- <用户名> <新密码>
// 生产需 .env 或环境变量提供 DATABASE_URL；PGlite 开发库需先停掉正在运行的 server。
import { loadEnvFileIfPresent } from '../lib/envfile.js';
loadEnvFileIfPresent();
import { loadConfig } from '../config.js';
import { createDb } from '../db/db.js';
import { hashPassword } from '../lib/password.js';

const [username, password] = process.argv.slice(2);

if (!username || !password || password.length < 8 || password.length > 72) {
  console.error('用法: npm run reset-password -- <用户名> <新密码(8-72位)>');
  process.exit(1);
}

const config = loadConfig();
const db = createDb(config);
try {
  const hash = await hashPassword(password);
  const res = await db.query('UPDATE users SET password_hash = $1, updated_at = now() WHERE username = $2', [
    hash,
    username,
  ]);
  if ((res.rowCount ?? 0) === 0) {
    console.error(`用户不存在: ${username}`);
    process.exitCode = 1;
  } else {
    console.log(`已重置 ${username} 的密码。`);
  }
} finally {
  await db.close();
}
