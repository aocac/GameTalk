/** 桌面端操作系统（游戏模式热键 / 焦点恢复分平台） */
export type DesktopOs = 'windows' | 'macos' | 'linux';

/** Windows / Linux 默认呼出键。macOS 不能用 Option+G（会输入 ©） */
export const WINDOWS_DEFAULT_HOTKEY = 'Alt+G';
/** macOS 默认呼出键：Control+Shift+G（Tauri 加速键写作 Ctrl） */
export const MACOS_DEFAULT_HOTKEY = 'Ctrl+Shift+G';
/** 更早的全局默认，持久化里遇到就升级到当前平台默认 */
export const LEGACY_DEFAULT_HOTKEY = 'Ctrl+Shift+Space';

/**
 * 探测当前桌面 OS。
 * Tauri webview 走 navigator；vitest/node 没有 navigator，回落 linux
 * （平台相关断言请把 os 显式传给 defaultHotkeyFor / migratePersistedSettings）。
 */
export function detectDesktopOs(): DesktopOs {
  if (typeof navigator === 'undefined') return 'linux';
  const plat = navigator.platform ?? '';
  const ua = navigator.userAgent ?? '';
  if (/Mac/i.test(plat) || /Mac OS X/i.test(ua)) return 'macos';
  if (/Win/i.test(plat) || /Windows/i.test(ua)) return 'windows';
  return 'linux';
}

export function defaultHotkeyFor(os: DesktopOs = detectDesktopOs()): string {
  return os === 'macos' ? MACOS_DEFAULT_HOTKEY : WINDOWS_DEFAULT_HOTKEY;
}

/** Tauri global-shortcut 的 Meta 修饰键名：macOS 是 Command，其余 Super */
export function metaModifierName(os: DesktopOs = detectDesktopOs()): 'Command' | 'Super' {
  return os === 'macos' ? 'Command' : 'Super';
}

/** e.key → Tauri global-shortcut 可识别的键名 */
export function normalizeHotkeyKey(e: Pick<KeyboardEvent, 'key'>): string | null {
  const key = e.key;
  if (key === ' ') return 'Space';
  if (key === 'Escape') return 'Esc';
  if (key === 'Enter') return 'Enter';
  if (key === 'Tab') return 'Tab';
  if (key.startsWith('Arrow')) return key.slice(5); // ArrowUp -> Up
  if (/^[a-zA-Z]$/.test(key)) return key.toUpperCase();
  if (/^[0-9]$/.test(key)) return key;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(key)) return key;
  return null;
}

/** 把一次 keydown 格式化成 Tauri 加速键字符串；纯修饰键返回 null */
export function formatHotkeyCombo(
  e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>,
  os: DesktopOs = detectDesktopOs(),
): string | null {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push(metaModifierName(os));
  const main = normalizeHotkeyKey(e);
  if (!main) return null;
  parts.push(main);
  return parts.join('+');
}
