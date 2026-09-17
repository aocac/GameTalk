// 把本地文件 PUT 到 S3 兼容对象存储（AWS / COS / OSS / MinIO）
// 用法：node dist/cli/push-backup.js <本地文件> [对象键文件名]
// 未配置 BACKUP_S3_* 时退出码 2（调用方应先判断再调）。
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { loadEnvFileIfPresent } from '../lib/envfile.js';
loadEnvFileIfPresent();
import { loadS3Config, objectKeyOf, putObject } from '../lib/s3.js';

const file = process.argv[2];
const name = process.argv[3] || (file ? basename(file) : '');

if (!file || !name) {
  console.error('用法: node dist/cli/push-backup.js <本地文件> [对象键文件名]');
  process.exit(1);
}

const cfg = loadS3Config();
if (!cfg) {
  console.error('未配置 BACKUP_S3_ENDPOINT / BACKUP_S3_BUCKET / BACKUP_S3_ACCESS_KEY / BACKUP_S3_SECRET_KEY，跳过上传');
  process.exit(2);
}

const body = await readFile(file);
const key = objectKeyOf(cfg.prefix, name);
const { url, status } = await putObject(cfg, key, body);
console.log(`uploaded ${name} → ${url} (${status}, ${body.length} bytes)`);
