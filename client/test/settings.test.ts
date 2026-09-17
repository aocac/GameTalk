import { describe, expect, it } from 'vitest';
import {
  defaultHotkeyFor,
  detectDesktopOs,
  formatHotkeyCombo,
  LEGACY_DEFAULT_HOTKEY,
  MACOS_DEFAULT_HOTKEY,
  metaModifierName,
  WINDOWS_DEFAULT_HOTKEY,
} from '../src/app/platform';
import {
  DEFAULT_HOTKEY,
  DEFAULT_SERVER_URL,
  FALLBACK_SERVER_URL,
  migratePersistedSettings,
  resolveDefaultServerUrl,
} from '../src/app/settings';

describe('默认服务器地址解析', () => {
  it('未注入（空串）时回落本地开发地址', () => {
    expect(resolveDefaultServerUrl('')).toBe(FALLBACK_SERVER_URL);
  });

  it('注入值为纯空白时同样回落', () => {
    expect(resolveDefaultServerUrl('   \n\t ')).toBe(FALLBACK_SERVER_URL);
  });

  it('注入自定义地址时原样采用', () => {
    expect(resolveDefaultServerUrl('https://chat.example.com')).toBe('https://chat.example.com');
  });

  it('去掉首尾空白与尾部斜杠（多根斜杠一并去掉）', () => {
    expect(resolveDefaultServerUrl('  https://chat.example.com///  ')).toBe('https://chat.example.com');
    expect(resolveDefaultServerUrl('https://chat.example.com/')).toBe('https://chat.example.com');
  });

  it('保留带端口与路径前缀的地址', () => {
    expect(resolveDefaultServerUrl('https://chat.example.com:8443')).toBe('https://chat.example.com:8443');
  });

  /**
   * 关键回归：单测与 `vite dev` 走的是非生产分支，即使开发机上存在 client/.env.local
   * 也不得把默认地址变成生产域名（否则本地测试会连线上）。
   */
  it('测试/开发环境不受 .env.local 注入影响，DEFAULT_SERVER_URL 恒为本地地址', () => {
    expect(DEFAULT_SERVER_URL).toBe(FALLBACK_SERVER_URL);
  });
});

describe('平台默认快捷键', () => {
  it('Windows / Linux 默认 Alt+G，macOS 默认 Ctrl+Shift+G', () => {
    expect(defaultHotkeyFor('windows')).toBe(WINDOWS_DEFAULT_HOTKEY);
    expect(defaultHotkeyFor('linux')).toBe(WINDOWS_DEFAULT_HOTKEY);
    expect(defaultHotkeyFor('macos')).toBe(MACOS_DEFAULT_HOTKEY);
    expect(WINDOWS_DEFAULT_HOTKEY).toBe('Alt+G');
    expect(MACOS_DEFAULT_HOTKEY).toBe('Ctrl+Shift+G');
  });

  it('vitest/node 下 DEFAULT_HOTKEY 跟随本机 OS', () => {
    expect(DEFAULT_HOTKEY).toBe(defaultHotkeyFor(detectDesktopOs()));
  });

  it('macOS 把 Meta 录成 Command，其它平台 Super', () => {
    expect(metaModifierName('macos')).toBe('Command');
    expect(metaModifierName('windows')).toBe('Super');
    expect(metaModifierName('linux')).toBe('Super');
  });

  it('formatHotkeyCombo 在 macOS 把 metaKey 写成 Command', () => {
    const e = { key: 'g', ctrlKey: false, altKey: false, shiftKey: false, metaKey: true };
    expect(formatHotkeyCombo(e, 'macos')).toBe('Command+G');
    expect(formatHotkeyCombo(e, 'linux')).toBe('Super+G');
  });

  it('formatHotkeyCombo 忽略纯修饰键', () => {
    expect(formatHotkeyCombo({ key: 'Shift', ctrlKey: false, altKey: false, shiftKey: true, metaKey: false })).toBeNull();
  });
});

describe('设置快捷键迁移', () => {
  it('Ctrl+Shift+Space 升级到当前平台默认', () => {
    expect(migratePersistedSettings({ hotkey: LEGACY_DEFAULT_HOTKEY }, 0, 'windows').hotkey).toBe('Alt+G');
    expect(migratePersistedSettings({ hotkey: LEGACY_DEFAULT_HOTKEY }, 1, 'macos').hotkey).toBe('Ctrl+Shift+G');
  });

  it('macOS 上 v2 之前的 Alt+G 升级到 Ctrl+Shift+G', () => {
    expect(migratePersistedSettings({ hotkey: 'Alt+G' }, 1, 'macos').hotkey).toBe('Ctrl+Shift+G');
  });

  it('Windows / Linux 上 Alt+G 保持不变', () => {
    expect(migratePersistedSettings({ hotkey: 'Alt+G' }, 1, 'windows').hotkey).toBe('Alt+G');
    expect(migratePersistedSettings({ hotkey: 'Alt+G' }, 1, 'linux').hotkey).toBe('Alt+G');
  });

  it('自定义组合键不受迁移影响', () => {
    expect(migratePersistedSettings({ hotkey: 'F8' }, 1, 'macos').hotkey).toBe('F8');
    expect(migratePersistedSettings({ hotkey: 'Alt+G' }, 2, 'macos').hotkey).toBe('Alt+G');
  });
});
