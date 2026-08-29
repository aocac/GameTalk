import { create } from 'zustand';
import { playMessageSound } from '../app/audio';
import { useSettings } from '../app/settings';
import { useAuth } from './auth';
import * as api from '../app/api';
import type { Friend, FriendRequestItem } from '../app/api';
import type { ServerWsMessage } from '../app/types';

/**
 * 好友 store：列表 / 申请收发 / 实时事件同步（friend:* 与 presence:friend 由 chat store 转发）。
 * 好友与房间完全分离管理；聊天（DM）不在本期范围。
 */
interface FriendsState {
  friends: Friend[];
  incoming: FriendRequestItem[];
  outgoing: FriendRequestItem[];
  loaded: boolean;
  error: string | null;
  /** 最近一次操作的提示（如「申请已发送」），自动清理由调用方负责 */
  notice: string | null;
  load: () => Promise<void>;
  sendRequest: (target: string) => Promise<boolean>;
  accept: (requestId: string) => Promise<void>;
  decline: (requestId: string) => Promise<void>;
  remove: (userId: string) => Promise<void>;
  relationOf: (userId: string) => 'self' | 'friends' | 'pending' | 'none';
  handleWs: (msg: ServerWsMessage) => void;
  clearNotice: () => void;
}

export const useFriends = create<FriendsState>()((set, get) => ({
  friends: [],
  incoming: [],
  outgoing: [],
  loaded: false,
  error: null,
  notice: null,

  load: async () => {
    const { token } = useAuth.getState();
    if (!token) return;
    try {
      const [{ friends }, reqs] = await Promise.all([api.listFriends(token), api.listFriendRequests(token)]);
      set({ friends, incoming: reqs.incoming, outgoing: reqs.outgoing, loaded: true, error: null });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : '加载好友列表失败' });
    }
  },

  sendRequest: async (target) => {
    const { token } = useAuth.getState();
    if (!token || !target.trim()) return false;
    set({ error: null, notice: null });
    try {
      const payload = target.trim().startsWith('#') ? { username: target.trim() } : { username: target.trim() };
      const { request } = await api.sendFriendRequest(token, payload);
      // 反向申请 = 直接成为好友
      if (request.status === 'accepted') {
        await get().load();
        set({ notice: `已与 ${request.user.username} 成为好友` });
      } else {
        set((s) => ({
          notice: `已向 ${request.user.username} 发送好友申请`,
          outgoing: [
            ...s.outgoing,
            { id: request.id, createdAt: new Date().toISOString(), user: { ...request.user, avatarUrl: null, bio: null } },
          ],
        }));
      }
      return true;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : '发送好友申请失败' });
      return false;
    }
  },

  accept: async (requestId) => {
    const { token } = useAuth.getState();
    if (!token) return;
    try {
      const { friend } = await api.acceptFriendRequest(token, requestId);
      set((s) => ({
        incoming: s.incoming.filter((r) => r.id !== requestId),
        friends: friend && !s.friends.some((f) => f.id === friend.id) ? [...s.friends, friend] : s.friends,
      }));
    } catch (e) {
      set({ error: e instanceof Error ? e.message : '同意申请失败' });
    }
  },

  decline: async (requestId) => {
    const { token } = useAuth.getState();
    if (!token) return;
    try {
      await api.declineFriendRequest(token, requestId);
      set((s) => ({ incoming: s.incoming.filter((r) => r.id !== requestId) }));
    } catch (e) {
      set({ error: e instanceof Error ? e.message : '拒绝申请失败' });
    }
  },

  remove: async (userId) => {
    const { token } = useAuth.getState();
    if (!token) return;
    try {
      await api.removeFriend(token, userId);
      set((s) => ({ friends: s.friends.filter((f) => f.id !== userId) }));
    } catch (e) {
      set({ error: e instanceof Error ? e.message : '删除好友失败' });
    }
  },

  relationOf: (userId) => {
    const s = get();
    const me = useAuth.getState().user?.id;
    if (userId === me) return 'self';
    if (s.friends.some((f) => f.id === userId)) return 'friends';
    const pending = [...s.incoming, ...s.outgoing].some((r) => r.user.id === userId);
    return pending ? 'pending' : 'none';
  },

  handleWs: (msg) => {
    switch (msg.type) {
      case 'friend:request': {
        set((s) => ({
          incoming: s.incoming.some((r) => r.id === msg.payload.requestId)
            ? s.incoming
            : [
                {
                  id: msg.payload.requestId,
                  createdAt: new Date().toISOString(),
                  user: { ...msg.payload.from, avatarUrl: msg.payload.from.avatarUrl ?? null, bio: msg.payload.from.bio ?? null },
                },
                ...s.incoming,
              ],
        }));
        playMessageSound(useSettings.getState().soundEnabled);
        break;
      }
      case 'friend:accepted': {
        const u = msg.payload.user;
        set((s) => ({
          friends: s.friends.some((f) => f.id === u.id) ? s.friends : [...s.friends, { ...u, avatarUrl: u.avatarUrl ?? null, bio: u.bio ?? null, online: true }],
          outgoing: s.outgoing.filter((r) => r.user.id !== u.id),
        }));
        break;
      }
      case 'friend:declined': {
        // 对方拒绝了我的申请：outgoing 按 user.id 移除（没有用户资料可对号，用 userId 对 outgoing 匹配）
        set((s) => ({
          outgoing: s.outgoing.filter((r) => r.user.id !== msg.payload.userId),
        }));
        break;
      }
      case 'friend:removed': {
        set((s) => ({ friends: s.friends.filter((f) => f.id !== msg.payload.userId) }));
        break;
      }
      case 'presence:friend': {
        set((s) => ({
          friends: s.friends.map((f) => (f.id === msg.payload.userId ? { ...f, online: msg.payload.online } : f)),
        }));
        break;
      }
      default:
        break;
    }
  },

  clearNotice: () => set({ notice: null }),
}));
