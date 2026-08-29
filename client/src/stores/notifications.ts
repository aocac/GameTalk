import { create } from 'zustand';

/**
 * 通知中心：@提及、好友申请等需要用户留意的事件聚合。
 * 会话级（不持久化）——未读提醒的价值集中在当前会话；历史提及由房间内高亮兜底。
 */
export type NoticeKind = 'mention' | 'friend_request' | 'friend_accepted';

export interface Notice {
  id: string;
  kind: NoticeKind;
  /** 展示文案（已含完整上下文） */
  text: string;
  /** mention 类点击后跳转的房间 */
  roomId?: string;
  createdAt: string;
  read: boolean;
}

interface NotificationsState {
  items: Notice[];
  unread: number;
  push: (n: Omit<Notice, 'id' | 'createdAt' | 'read'>) => void;
  markAllRead: () => void;
  clear: () => void;
}

let seq = 0;

export const useNotifications = create<NotificationsState>()((set) => ({
  items: [],
  unread: 0,

  push: (n) =>
    set((s) => ({
      items: [{ ...n, id: `n-${Date.now()}-${++seq}`, createdAt: new Date().toISOString(), read: false }, ...s.items].slice(0, 100),
      unread: s.unread + 1,
    })),

  markAllRead: () => set((s) => ({ items: s.items.map((i) => ({ ...i, read: true })), unread: 0 })),

  clear: () => set({ items: [], unread: 0 }),
}));
