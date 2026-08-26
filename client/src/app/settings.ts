import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface AppSettings {
  /** 服务端地址（REST），WS 地址由此推导 */
  serverUrl: string;
  /** 消息提示音开关 */
  soundEnabled: boolean;
  /** 快捷会话昵称（Phase 3 后由账号体系取代） */
  quickName: string;
  setServerUrl: (url: string) => void;
  setSoundEnabled: (v: boolean) => void;
  setQuickName: (name: string) => void;
}

export const DEFAULT_SERVER_URL = 'http://127.0.0.1:8787';

export function wsUrlOf(serverUrl: string): string {
  const base = serverUrl.trim().replace(/\/+$/, '');
  return base.replace(/^http/, 'ws') + '/ws';
}

export const useSettings = create<AppSettings>()(
  persist(
    (set) => ({
      serverUrl: DEFAULT_SERVER_URL,
      soundEnabled: true,
      quickName: '',
      setServerUrl: (serverUrl) => set({ serverUrl: serverUrl.trim() }),
      setSoundEnabled: (soundEnabled) => set({ soundEnabled }),
      setQuickName: (quickName) => set({ quickName }),
    }),
    { name: 'gametalk-settings' },
  ),
);
