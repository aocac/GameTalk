/**
 * 设备标识：一次安装生成一次，落在 localStorage。
 *
 * 服务端用它做「同账号单设备登录」——同一个客户端实例的所有窗口
 * （主窗、采集窗、观看窗、设置窗）都会带上同一个值，所以在服务端看来它们是同一台设备，
 * 不会互相顶掉；只有换了机器/清了浏览器存储才算新设备。
 */
const KEY = 'gametalk-device-id';
const VALID = /^[A-Za-z0-9_-]{8,64}$/;

let cached: string | null = null;

export function deviceId(): string {
  if (cached) return cached;
  try {
    const existing = localStorage.getItem(KEY);
    if (existing && VALID.test(existing)) {
      cached = existing;
      return cached;
    }
    const fresh = (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`).replace(
      /-/g,
      '',
    );
    localStorage.setItem(KEY, fresh);
    cached = fresh;
    return cached;
  } catch {
    // localStorage 被禁用（隐私模式等）：退化为固定值，同账号多开会被服务端视为同一台设备
    cached = 'unknown-device';
    return cached;
  }
}
