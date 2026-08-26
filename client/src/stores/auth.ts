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

      logout() {
        set({ token: null, user: null });
      },

      clearError() {
        set({ error: null });
      },
    }),
    {
      name: 'gametalk-auth',
      storage: typeof window !== 'undefined' ? createJSONStorage(() => localStorage) : createJSONStorage(() => memoryStorage),
    },
  ),
);
