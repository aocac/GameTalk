import { createServer, type IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { loadS3Config, objectKeyOf, putObject, signPutObject, type S3Config } from '../src/lib/s3.js';

const fixture: S3Config = {
  endpoint: 'https://s3.example.test',
  region: 'us-east-1',
  bucket: 'gametalk-backups',
  accessKey: 'AKIAIOSFODNN7EXAMPLE',
  secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  pathStyle: true,
  prefix: 'gametalk/',
};

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

describe('S3-compatible backup uploader', () => {
  it('loadS3Config requires the four credentials', () => {
    expect(loadS3Config({})).toBeNull();
    expect(loadS3Config({ BACKUP_S3_ENDPOINT: 'https://s3.test', BACKUP_S3_BUCKET: 'b' })).toBeNull();
    const cfg = loadS3Config({
      BACKUP_S3_ENDPOINT: 'https://s3.test',
      BACKUP_S3_BUCKET: 'b',
      BACKUP_S3_ACCESS_KEY: 'a',
      BACKUP_S3_SECRET_KEY: 's',
      BACKUP_S3_REGION: 'ap-guangzhou',
      BACKUP_S3_PREFIX: 'gt/',
    });
    expect(cfg).toMatchObject({
      endpoint: 'https://s3.test',
      bucket: 'b',
      region: 'ap-guangzhou',
      prefix: 'gt/',
      pathStyle: true,
    });
  });

  it('object keys sit under the configured prefix', () => {
    expect(objectKeyOf('gametalk/', 'dump.dump')).toBe('gametalk/dump.dump');
    expect(objectKeyOf('gametalk', 'dump.dump')).toBe('gametalk/dump.dump');
  });

  it('SigV4 signature is stable for a frozen timestamp', () => {
    const now = new Date('2013-05-24T00:00:00.000Z');
    const body = Buffer.from('hello backups');
    const a = signPutObject(fixture, 'gametalk/hello.txt', body, now);
    const b = signPutObject(fixture, 'gametalk/hello.txt', body, now);
    expect(a.signature).toBe(b.signature);
    expect(a.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(a.headers.Authorization).toContain('AWS4-HMAC-SHA256 Credential=');
    expect(a.headers.Authorization).toContain(a.signature);
    expect(a.url).toBe('https://s3.example.test/gametalk-backups/gametalk/hello.txt');
    expect(a.canonicalRequest.startsWith('PUT\n/gametalk-backups/gametalk/hello.txt\n')).toBe(true);
  });

  it('PUT reaches an S3-compatible endpoint with the file bytes', async () => {
    const received: { url?: string; auth?: string; body?: Buffer } = {};
    const server = createServer((req, res) => {
      void readBody(req).then((body) => {
        received.url = req.url;
        received.auth = String(req.headers.authorization ?? '');
        received.body = body;
        res.statusCode = 200;
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    try {
      const cfg: S3Config = { ...fixture, endpoint: `http://127.0.0.1:${port}` };
      const payload = Buffer.from('pg_dump-bytes');
      const result = await putObject(cfg, 'gametalk/x.dump', payload);
      expect(result.status).toBe(200);
      expect(received.url).toBe('/gametalk-backups/gametalk/x.dump');
      expect(received.auth).toMatch(/^AWS4-HMAC-SHA256 /);
      expect(received.body?.equals(payload)).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });
});
