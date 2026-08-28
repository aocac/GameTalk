import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';
import * as api from '../app/api';

interface AuthState {
  token: string | null;
  user: api.PublicUser | null;
  busy: boolean;
  error: string | null;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string) => Promise<void>;
  refreshMe: () => Promise<void>;
  updateProfile: (patch: { username?: string; avatarUrl?: string; bio?: string }) => Promise<void>;
  uploadAvatar: (dataUrl: string) => Promise<void>;
  logout: () => void;
  clearError: () => void;
}

const memoryStorage: StateStorage = {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
};

export const useAuth = create<AuthState>()(
  persist(
    (set, get) => ({
      token: null,
      user: null,
      busy: false,
      error: null,

      async login(username, password) {
        set({ busy: true, error: null });
        try {
          const res = await api.login(username, password);
          set({ token: res.token, user: res.user });
        } catch (e) {
          set({ error: e instanceof Error ? e.message : '登录失败' });
          throw e;
        } finally {
          set({ busy: false });
        }
      },

      async register(username, password) {
        set({ busy: true, error: null });
        try {
          const res = await api.register(username, password);
          set({ token: res.token, user: res.user });
        } catch (e) {
          set({ error: e instanceof Error ? e.message : '注册失败' });
          throw e;
        } finally {
          set({ busy: false });
        }
      },

      async refreshMe() {
        const { token } = get();
        if (!token) return;
        try {
          const { user } = await api.fetchMe(token);
          set({ user });
        } catch {
          // token 失效时登出
          set({ token: null, user: null });
        }
      },

      async updateProfile(patch) {
        const { token } = get();
        if (!token) return;
        set({ busy: true, error: null });
        try {
          const { user } = await api.patchMe(token, patch);
          set({ user });
        } catch (e) {
          set({ error: e instanceof Error ? e.message : '更新资料失败' });
          throw e;
        } finally {
          set({ busy: false });
        }
      },

      async uploadAvatar(dataUrl: string) {
        const { token } = get();
        if (!token) return;
        set({ busy: true, error: null });
        try {
          const { user } = await api.uploadAvatar(token, dataUrl);
          set({ user });
        } catch (e) {
          set({ error: e instanceof Error ? e.message : '上传头像失败' });
          throw e;
        } finally {
          set({ busy: false });
        }
      },

      logout() {
        set({ token: null, user: null });
      },

      clearError() {
        set({ error: null });
      },
    }),
    {
      name: 'gametalk-auth',
      // 只持久化 token/user：error/busy 是瞬态，绝不落盘（否则上次登录失败的错误
      // 会在下次启动时残留显示）
      version: 1,
      migrate: (persisted) => {
        const p = persisted as { token?: string | null; user?: api.PublicUser | null };
        return { token: p.token ?? null, user: p.user ?? null };
      },
      partialize: (s) => ({ token: s.token, user: s.user }),
      storage: typeof window !== 'undefined' ? createJSONStorage(() => localStorage) : createJSONStorage(() => memoryStorage),
    },
  ),
);
