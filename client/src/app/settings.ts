import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';

export type OverlayPosition =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right';

export interface AppSettings {
  /** 服务端地址（REST），WS 地址由此推导 */
  serverUrl: string;
  /** 消息提示音开关 */
  soundEnabled: boolean;
  /** 游戏模式开关 */
  gameModeEnabled: boolean;
  /** 呼出输入框的全局快捷键 */
  hotkey: string;
  /** 消息 Overlay 位置预设 */
  overlayPosition: OverlayPosition;
  /** 消息 Overlay 缩放比例（0.5 ~ 2.0） */
  overlayScale: number;
  /** 消息 Overlay 自动隐藏时长（秒） */
  overlayDurationSec: number;
  setServerUrl: (url: string) => void;
  setSoundEnabled: (v: boolean) => void;
  setGameModeEnabled: (v: boolean) => void;
  setHotkey: (v: string) => void;
  setOverlayPosition: (v: OverlayPosition) => void;
  setOverlayScale: (v: number) => void;
  setOverlayDurationSec: (v: number) => void;
}

export const DEFAULT_SERVER_URL = 'http://127.0.0.1:8787';
export const DEFAULT_HOTKEY = 'Ctrl+Shift+Space';
export const OVERLAY_BASE_WIDTH = 380;
export const OVERLAY_BASE_HEIGHT = 180;

export function wsUrlOf(serverUrl: string): string {
  const base = serverUrl.trim().replace(/\/+$/, '');
  return base.replace(/^http/, 'ws') + '/ws';
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
      gameModeEnabled: false,
      hotkey: DEFAULT_HOTKEY,
      overlayPosition: 'bottom-left',
      overlayScale: 1,
      overlayDurationSec: 6,
      setServerUrl: (serverUrl) => set({ serverUrl: serverUrl.trim() }),
      setSoundEnabled: (soundEnabled) => set({ soundEnabled }),
      setGameModeEnabled: (gameModeEnabled) => set({ gameModeEnabled }),
      setHotkey: (hotkey) => set({ hotkey: hotkey.trim() || DEFAULT_HOTKEY }),
      setOverlayPosition: (overlayPosition) => set({ overlayPosition }),
      setOverlayScale: (overlayScale) => set({ overlayScale: Math.min(2, Math.max(0.5, overlayScale)) }),
      setOverlayDurationSec: (overlayDurationSec) => set({ overlayDurationSec: Math.min(30, Math.max(2, overlayDurationSec)) }),
    }),
    {
      name: 'gametalk-settings',
      storage: typeof window !== 'undefined' ? createJSONStorage(() => localStorage) : createJSONStorage(() => memoryStorage),
    },
  ),
);
