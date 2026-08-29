import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';
import { invoke } from '@tauri-apps/api/core';

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

export interface AppSettings {
  /** 服务端地址（REST），WS 地址由此推导 */
  serverUrl: string;
  /** 消息提示音开关 */
  soundEnabled: boolean;
  /** 游戏模式开关 */
  gameModeEnabled: boolean;
  /** 呼出输入框的全局快捷键 */
  hotkey: string;
  /** 消息 Overlay 位置预设（custom = 使用拖拽自定义位置） */
  overlayPosition: OverlayPosition;
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
  setServerUrl: (url: string) => void;
  setSoundEnabled: (v: boolean) => void;
  setGameModeEnabled: (v: boolean) => void;
  setHotkey: (v: string) => void;
  setOverlayPosition: (v: OverlayPosition) => void;
  setOverlayCustomPosition: (v: OverlayPositionState | null) => void;
  setOverlayScale: (v: number) => void;
  setOverlayDurationSec: (v: number) => void;
  setUseProxy: (v: boolean) => void;
  setProxyAddress: (v: string) => void;
}

export const DEFAULT_SERVER_URL = 'http://127.0.0.1:8787';
/** v0.4.2 起默认快捷键：Alt+G（原 Ctrl+Shift+Space 过长且 Space 在游戏内常用） */
export const DEFAULT_HOTKEY = 'Alt+G';
/** 旧默认快捷键：持久化了该值的用户在迁移时升级到新默认（自定义键不受影响） */
export const LEGACY_DEFAULT_HOTKEY = 'Ctrl+Shift+Space';
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
      gameModeEnabled: true,
      hotkey: DEFAULT_HOTKEY,
      overlayPosition: 'top-left',
      overlayCustomPosition: null,
      overlayScale: 1,
      overlayDurationSec: 6,
      useProxy: false,
      proxyAddress: '',
      setServerUrl: (serverUrl) => set({ serverUrl: serverUrl.trim().replace(/\/+$/, '') }),
      setSoundEnabled: (soundEnabled) => set({ soundEnabled }),
      setGameModeEnabled: (gameModeEnabled) => set({ gameModeEnabled }),
      setHotkey: (hotkey) => set({ hotkey: hotkey.trim() || DEFAULT_HOTKEY }),
      setOverlayPosition: (overlayPosition) => set({ overlayPosition }),
      setOverlayCustomPosition: (overlayCustomPosition) => set({ overlayCustomPosition }),
      setOverlayScale: (overlayScale) => set({ overlayScale: Math.min(2, Math.max(0.5, overlayScale)) }),
      setOverlayDurationSec: (overlayDurationSec) => set({ overlayDurationSec: Math.min(30, Math.max(2, overlayDurationSec)) }),
      setUseProxy: (useProxy) => set({ useProxy }),
      setProxyAddress: (proxyAddress) => set({ proxyAddress: proxyAddress.trim() }),
    }),
    {
      name: 'gametalk-settings',
      version: 1,
      migrate: (persisted) => {
        const p = persisted as Partial<AppSettings>;
        // 仍为旧默认键的用户自动切到新默认（自定义过快捷键的不动）
        if (p.hotkey === LEGACY_DEFAULT_HOTKEY) p.hotkey = DEFAULT_HOTKEY;
        return p as AppSettings;
      },
      storage: typeof window !== 'undefined' ? createJSONStorage(() => localStorage) : createJSONStorage(() => memoryStorage),
    },
  ),
);
