/** 入参校验：UUID 直接进 SQL 前必须先过这里，否则非法串会变成 22P02/23503 → 500 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** 非字符串的文本入参统一归一化为空串（客户端可发任意 JSON 类型） */
export function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
