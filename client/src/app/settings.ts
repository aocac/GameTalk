import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';

export interface AppSettings {
  /** 服务端地址（REST），WS 地址由此推导 */
  serverUrl: string;
  /** 消息提示音开关 */
  soundEnabled: boolean;
  setServerUrl: (url: string) => void;
  setSoundEnabled: (v: boolean) => void;
}

export const DEFAULT_SERVER_URL = 'http://127.0.0.1:8787';

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
      setServerUrl: (serverUrl) => set({ serverUrl: serverUrl.trim() }),
      setSoundEnabled: (soundEnabled) => set({ soundEnabled }),
    }),
    {
      name: 'gametalk-settings',
      storage: typeof window !== 'undefined' ? createJSONStorage(() => localStorage) : createJSONStorage(() => memoryStorage),
    },
  ),
);
