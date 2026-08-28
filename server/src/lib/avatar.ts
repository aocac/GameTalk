/**
 * 头像 URL 策略：
 * - users.avatar_url 存储原始值（上传的 data URL 或用户手填的外链）
 * - 对外（REST 响应 / WS 广播）一律不回传 base64 data URL——否则 3MB 头像会随
 *   每条消息广播、随成员表全量内嵌；data URL 一律转成 /api/avatars/:id 的绝对 URL
 * - 外链 URL 原样返回
 */

/** 从请求头推导对外的 http(s) base（反代后取 X-Forwarded-Proto） */
export function httpBaseOf(headers: {
  host?: string | undefined;
  'x-forwarded-proto'?: string | string[] | undefined;
}): string {
  const raw = Array.isArray(headers['x-forwarded-proto'])
    ? headers['x-forwarded-proto'][0]
    : headers['x-forwarded-proto'];
  const proto = String(raw ?? 'http').split(',')[0].trim() || 'http';
  const host = headers.host ?? 'localhost';
  return `${proto}://${host}`;
}

/** 原始存储值 → 对外 URL（data URL → 端点；外链原样；空 → null） */
export function avatarHttpUrlOf(httpBase: string, userId: string, stored: string | null): string | null {
  if (!stored) return null;
  if (stored.startsWith('data:')) return `${httpBase}/api/avatars/${userId}`;
  return stored;
}
