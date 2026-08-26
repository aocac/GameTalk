import type { FastifyReply, FastifyRequest } from 'fastify';
import type { JwtService } from '../lib/jwt.js';

declare module 'fastify' {
  interface FastifyRequest {
    userId?: string;
    username?: string;
  }
}

function bearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim() || null;
}

/**
 * 生成 REST 认证 preHandler：从 Authorization: Bearer <jwt> 解析用户。
 */
export function makeAuthPreHandler(jwt: JwtService) {
  return async function authPreHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const token = bearerToken(req);
    if (!token) {
      await reply.code(401).send({ error: { code: 'unauthorized', message: 'missing token' } });
      return;
    }
    try {
      const payload = await jwt.verify(token);
      req.userId = payload.sub;
      req.username = payload.username;
    } catch {
      await reply.code(401).send({ error: { code: 'unauthorized', message: 'invalid or expired token' } });
    }
  };
}
