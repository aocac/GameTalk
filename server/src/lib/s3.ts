import { createHash, createHmac } from 'node:crypto';

export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  /** 默认 true：路径风格 /bucket/key，兼容 MinIO / COS / OSS 的 S3 API */
  pathStyle: boolean;
  /** 对象键前缀，默认 gametalk/ */
  prefix: string;
}

export function loadS3Config(env: NodeJS.ProcessEnv = process.env): S3Config | null {
  const endpoint = (env.BACKUP_S3_ENDPOINT || '').trim();
  const bucket = (env.BACKUP_S3_BUCKET || '').trim();
  const accessKey = (env.BACKUP_S3_ACCESS_KEY || '').trim();
  const secretKey = (env.BACKUP_S3_SECRET_KEY || '').trim();
  if (!endpoint || !bucket || !accessKey || !secretKey) return null;
  const pathStyleRaw = (env.BACKUP_S3_PATH_STYLE || 'true').trim().toLowerCase();
  return {
    endpoint,
    region: (env.BACKUP_S3_REGION || 'us-east-1').trim() || 'us-east-1',
    bucket,
    accessKey,
    secretKey,
    pathStyle: pathStyleRaw !== '0' && pathStyleRaw !== 'false' && pathStyleRaw !== 'no',
    prefix: (env.BACKUP_S3_PREFIX || 'gametalk/').trim() || 'gametalk/',
  };
}

function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

function amzDateOf(now: Date): { amzDate: string; dateStamp: string } {
  const iso = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

function encodePath(segments: string[]): string {
  return (
    '/' +
    segments
      .filter((s) => s.length > 0)
      .map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
      .join('/')
  );
}

export interface SignedPut {
  url: string;
  headers: Record<string, string>;
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
}

export function objectKeyOf(prefix: string, name: string): string {
  const p = prefix.endsWith('/') ? prefix : `${prefix}/`;
  const n = name.replace(/^\/+/, '');
  return `${p}${n}`;
}

/** 构造 SigV4 签名的 PUT（不发网络）。now 可注入以便单测固定向量。 */
export function signPutObject(
  cfg: S3Config,
  key: string,
  body: Buffer,
  now: Date = new Date(),
  contentType = 'application/octet-stream',
): SignedPut {
  const endpoint = new URL(cfg.endpoint.includes('://') ? cfg.endpoint : `https://${cfg.endpoint}`);
  const { amzDate, dateStamp } = amzDateOf(now);
  const payloadHash = sha256Hex(body);
  const host = cfg.pathStyle ? endpoint.host : `${cfg.bucket}.${endpoint.host}`;
  const canonicalUri = cfg.pathStyle ? encodePath([cfg.bucket, ...key.split('/')]) : encodePath(key.split('/'));
  const canonicalHeaders = `content-type:${contentType}\nhost:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = ['PUT', canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const credentialScope = `${dateStamp}/${cfg.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, sha256Hex(canonicalRequest)].join('\n');
  const kDate = hmac(`AWS4${cfg.secretKey}`, dateStamp);
  const kRegion = hmac(kDate, cfg.region);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
  const authorization = `AWS4-HMAC-SHA256 Credential=${cfg.accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const url = `${endpoint.protocol}//${host}${canonicalUri}`;
  return {
    url,
    headers: {
      Host: host,
      'Content-Type': contentType,
      'Content-Length': String(body.length),
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      Authorization: authorization,
    },
    canonicalRequest,
    stringToSign,
    signature,
  };
}

export async function putObject(
  cfg: S3Config,
  key: string,
  body: Buffer,
  now: Date = new Date(),
): Promise<{ url: string; status: number }> {
  const signed = signPutObject(cfg, key, body, now);
  const res = await fetch(signed.url, { method: 'PUT', headers: signed.headers, body });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`S3 PUT ${res.status} ${signed.url}: ${text.slice(0, 300)}`);
  }
  return { url: signed.url, status: res.status };
}
