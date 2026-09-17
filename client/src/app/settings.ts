import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';
import { invoke } from '@tauri-apps/api/core';
import type { ShareQuality } from './screenShare';
import type { ThemeSetting } from './theme';
import {
  defaultHotkeyFor,
  detectDesktopOs,
  LEGACY_DEFAULT_HOTKEY,
  MACOS_DEFAULT_HOTKEY,
  WINDOWS_DEFAULT_HOTKEY,
  type DesktopOs,
} from './platform';

export type { ShareQuality };
export type { ThemeSetting };
export {
  defaultHotkeyFor,
  detectDesktopOs,
  LEGACY_DEFAULT_HOTKEY,
  MACOS_DEFAULT_HOTKEY,
  WINDOWS_DEFAULT_HOTKEY,
};
export type { DesktopOs };

export type OverlayPosition =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right'
  | 'custom';

export interface OverlayPositionState {
  x: number;
  y: number;
}

/** Windows 系统通知档位：all=全部他人消息 / mention=仅 @我 与私聊 / none=不弹系统通知 */
export type NotifyLevel = 'all' | 'mention' | 'none';

export interface AppSettings {
  /** 服务端地址（REST），WS 地址由此推导 */
  serverUrl: string;
  /** 消息提示音开关 */
  soundEnabled: boolean;
  /** 提示音音量（0-100） */
  soundVolume: number;
  /** Windows 系统通知档位 */
  notifyLevel: NotifyLevel;
  /** 游戏模式开关 */
  gameModeEnabled: boolean;
  /** 呼出输入框的全局快捷键 */
  hotkey: string;
  /** 消息 Overlay 位置预设（custom = 使用拖拽自定义位置） */
  overlayPosition: OverlayPosition;
  /** 启用屏幕覆盖（游戏中实时叠加显示新消息；默认开启） */
  overlayEnabled: boolean;
  /** 拖拽自定义位置（overlayPosition='custom' 时生效，物理像素） */
  overlayCustomPosition: OverlayPositionState | null;
  /** 消息 Overlay 缩放比例（0.5 ~ 2.0） */
  overlayScale: number;
  /** 消息 Overlay 自动隐藏时长（秒） */
  overlayDurationSec: number;
  /** 启用代理（默认关闭=不走代理，直连服务器） */
  useProxy: boolean;
  /** 代理地址，如 127.0.0.1:7890 */
  proxyAddress: string;
  /** 界面主题：跟随系统 / 浅色 / 深色 */
  theme: ThemeSetting;
  /** 屏幕共享画质档位：自动 / 清晰优先 / 流畅优先 / 省流量 */
  shareQuality: ShareQuality;
  /** 屏幕共享上行总预算（Mbps）：按观看人数分摊，每路有下限 */
  shareBudgetMbps: number;
  /** 共享包含系统声音时，静音本应用的提示音（避免自己的提示音被采进共享流） */
  shareMuteOwnSounds: boolean;
  setServerUrl: (url: string) => void;
  setSoundEnabled: (v: boolean) => void;
  setSoundVolume: (v: number) => void;
  setNotifyLevel: (v: NotifyLevel) => void;
  setGameModeEnabled: (v: boolean) => void;
  setHotkey: (v: string) => void;
  setOverlayPosition: (v: OverlayPosition) => void;
  setOverlayEnabled: (v: boolean) => void;
  setOverlayCustomPosition: (v: OverlayPositionState | null) => void;
  setOverlayScale: (v: number) => void;
  setOverlayDurationSec: (v: number) => void;
  setUseProxy: (v: boolean) => void;
  setProxyAddress: (v: string) => void;
  setTheme: (v: ThemeSetting) => void;
  setShareQuality: (v: ShareQuality) => void;
  setShareBudgetMbps: (v: number) => void;
  setShareMuteOwnSounds: (v: boolean) => void;
}

/** 未注入默认服务器地址时的兜底（本地开发 / 公开仓库与 CI 构建） */
export const FALLBACK_SERVER_URL = 'http://127.0.0.1:8787';

/**
 * 构建期注入的默认服务器地址，只在生产构建生效。
 *
 * - 本地打包机把真实地址写在 `client/.env.local`（已 gitignore，模板见 `client/.env.example`），
 *   打出的安装包首次启动即指向该地址，玩家不必手填。
 * - 公开仓库与 CI 没有该文件 → 回落 FALLBACK_SERVER_URL。
 * - `vite dev` 与 vitest 一律不注入：避免开发机上存在 `.env.local` 时把开发环境和
 *   单测指向生产服务器（历史坑：本地测试误连线上）。
 */
function readInjectedServerUrl(): string {
  if (!import.meta.env.PROD) return '';
  const injected = import.meta.env.VITE_DEFAULT_SERVER_URL;
  return typeof injected === 'string' ? injected : '';
}

/** 归一化服务器地址：去空白、去尾部斜杠；空值回落兜底地址（纯函数，便于单测） */
export function resolveDefaultServerUrl(injected: string): string {
  return injected.trim().replace(/\/+$/, '') || FALLBACK_SERVER_URL;
}

export const DEFAULT_SERVER_URL = resolveDefaultServerUrl(readInjectedServerUrl());

/** 当前平台的默认呼出快捷键（macOS 为 Ctrl+Shift+G，其余 Alt+G） */
export const DEFAULT_HOTKEY = defaultHotkeyFor();
export const OVERLAY_BASE_WIDTH = 380;
export const OVERLAY_BASE_HEIGHT = 180;

export function wsUrlOf(serverUrl: string): string {
  const base = serverUrl.trim().replace(/\/+$/, '');
  return base.replace(/^http/, 'ws') + '/ws';
}

/**
 * 应用代理设置到 WebView（立即生效，无需重启）：
 * - 启用且填了地址 → 走该代理（Network.setProxyOverride）
 * - 关闭 → 直连（绕过系统代理，默认行为）
 */
export async function applyProxySetting(useProxy: boolean, proxyAddress: string): Promise<void> {
  try {
    await invoke('set_proxy', { enabled: useProxy && !!proxyAddress.trim(), addr: proxyAddress.trim() });
  } catch {
    // 非 Tauri 环境（浏览器调试/测试）下无此命令，忽略
  }
}

/**
 * 设置持久化迁移。os 可注入便于单测；正式运行用 detectDesktopOs()。
 * - 仍写着 Ctrl+Shift+Space 的用户 → 当前平台默认
 * - v2 之前 macOS 上的 Alt+G（曾是全平台默认，Option+G 会输入 ©）→ Ctrl+Shift+G
 * - 用户自定义过的其它组合键不改
 */
export function migratePersistedSettings(
  persisted: unknown,
  fromVersion: number,
  os: DesktopOs = detectDesktopOs(),
): AppSettings {
  const p = { ...((persisted ?? {}) as Partial<AppSettings>) };
  const platformDefault = defaultHotkeyFor(os);
  if (!p.hotkey || p.hotkey === LEGACY_DEFAULT_HOTKEY) {
    p.hotkey = platformDefault;
  } else if (fromVersion < 2 && os === 'macos' && p.hotkey === WINDOWS_DEFAULT_HOTKEY) {
    p.hotkey = MACOS_DEFAULT_HOTKEY;
  }
  return p as AppSettings;
}

/** 非浏览器环境（vitest node）下的内存存储兜底 */
const memoryStorage: StateStorage = {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
};

export const useSettings = create<AppSettings>()(
  persist(
    (set) => ({
      serverUrl: DEFAULT_SERVER_URL,
      soundEnabled: true,
      soundVolume: 70,
      notifyLevel: 'mention',
      gameModeEnabled: true,
      hotkey: DEFAULT_HOTKEY,
      overlayPosition: 'top-left',
      overlayEnabled: true,
      overlayCustomPosition: null,
      overlayScale: 1,
      overlayDurationSec: 6,
      useProxy: false,
      proxyAddress: '',
      theme: 'auto',
      shareQuality: 'auto',
      shareBudgetMbps: 12,
      shareMuteOwnSounds: true,
      setServerUrl: (serverUrl) => set({ serverUrl: serverUrl.trim().replace(/\/+$/, '') }),
      setSoundEnabled: (soundEnabled) => set({ soundEnabled }),
      setSoundVolume: (soundVolume) => set({ soundVolume: Math.min(100, Math.max(0, Math.round(soundVolume))) }),
      setNotifyLevel: (notifyLevel) => set({ notifyLevel }),
      setGameModeEnabled: (gameModeEnabled) => set({ gameModeEnabled }),
      setHotkey: (hotkey) => set({ hotkey: hotkey.trim() || defaultHotkeyFor() }),
      setOverlayPosition: (overlayPosition) => set({ overlayPosition }),
      setOverlayEnabled: (overlayEnabled) => set({ overlayEnabled }),
      setOverlayCustomPosition: (overlayCustomPosition) => set({ overlayCustomPosition }),
      setOverlayScale: (overlayScale) => set({ overlayScale: Math.min(2, Math.max(0.5, overlayScale)) }),
      setOverlayDurationSec: (overlayDurationSec) => set({ overlayDurationSec: Math.min(30, Math.max(2, overlayDurationSec)) }),
      setUseProxy: (useProxy) => set({ useProxy }),
      setProxyAddress: (proxyAddress) => set({ proxyAddress: proxyAddress.trim() }),
      setTheme: (theme) => set({ theme }),
      setShareQuality: (shareQuality) => set({ shareQuality }),
      setShareBudgetMbps: (shareBudgetMbps) => set({ shareBudgetMbps: Math.min(50, Math.max(2, shareBudgetMbps)) }),
      setShareMuteOwnSounds: (shareMuteOwnSounds) => set({ shareMuteOwnSounds }),
    }),
    {
      name: 'gametalk-settings',
      version: 2,
      migrate: (persisted, fromVersion) => migratePersistedSettings(persisted, fromVersion),
      storage: typeof window !== 'undefined' ? createJSONStorage(() => localStorage) : createJSONStorage(() => memoryStorage),
    },
  ),
);
