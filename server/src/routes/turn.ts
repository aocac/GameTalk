import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import type { JwtService } from '../lib/jwt.js';
import { makeAuthPreHandler } from '../plugins/auth.js';

export interface TurnDeps {
  config: Config;
  jwt: JwtService;
}

/**
 * coturn use-auth-secret（REST 凭据）约定：
 * username = '<unix 到期时间戳>:<userId>'，credential = base64(HMAC-SHA1(secret, username))。
 * 密钥只存在服务端，客户端凭据限时（默认 1 小时），避免把中继做成无鉴权的开放中继。
 */
export function mintTurnCredential(secret: string, userId: string, ttlSeconds = 3600): { username: string; credential: string } {
  const username = `${Math.floor(Date.now() / 1000) + ttlSeconds}:${userId}`;
  const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
  return { username, credential };
}

export function registerTurnRoutes(app: FastifyInstance, deps: TurnDeps): void {
  const auth = makeAuthPreHandler(deps.jwt);

  // 屏幕共享跨网络兜底：返回服务端自建 coturn 的限时 ICE 凭据（未配置 TURN 时为空数组，客户端仅用 STUN）
  app.get('/api/turn', { preHandler: [auth] }, async (req, reply) => {
    if (!req.userId) {
      await reply.code(401).send({ error: { code: 'unauthorized', message: 'unauthorized' } });
      return;
    }
    const { turnSecret, turnUrls } = deps.config;
    if (!turnSecret || turnUrls.length === 0) {
      await reply.send({ iceServers: [] });
      return;
    }
    const { username, credential } = mintTurnCredential(turnSecret, req.userId, 3600);
    await reply.send({ iceServers: [{ urls: turnUrls, username, credential }] });
  });
}
