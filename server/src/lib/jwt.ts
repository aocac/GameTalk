import { SignJWT, jwtVerify } from 'jose';

export interface JwtPayload {
  /** 用户 ID */
  sub: string;
  username: string;
}

function parseExpiresIn(value: string): number {
  const m = /^(\d+)([smhd])$/.exec(value.trim());
  if (!m) return 7 * 24 * 3600;
  const n = parseInt(m[1], 10);
  switch (m[2]) {
    case 's':
      return n;
    case 'm':
      return n * 60;
    case 'h':
      return n * 3600;
    default:
      return n * 86400;
  }
}

export interface JwtService {
  sign(payload: JwtPayload): Promise<string>;
  verify(token: string): Promise<JwtPayload>;
}

export function createJwtService(secret: string, expiresIn: string): JwtService {
  const key = new TextEncoder().encode(secret);
  const expiresSec = parseExpiresIn(expiresIn);
  return {
    async sign(payload) {
      return new SignJWT({ username: payload.username })
        .setSubject(payload.sub)
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime(`${expiresSec}s`)
        .sign(key);
    },
    async verify(token) {
      const { payload } = await jwtVerify(token, key);
      if (!payload.sub) throw new Error('token missing subject');
      return { sub: payload.sub, username: (payload.username as string) ?? '' };
    },
  };
}
