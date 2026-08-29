import { create } from 'zustand';
import { ChatSocket } from '../app/ws';
import { playMessageSound, playSendSound } from '../app/audio';
import { useSettings } from '../app/settings';
import { useAuth } from './auth';
import { useFriends } from './friends';
import { useNotifications } from './notifications';
import { wsUrlOf } from '../app/settings';
import * as api from '../app/api';
import { pushOverlayMessage } from '../app/gameMode';
import type { ChatMessage, RoomMember, UserBrief, WsStatus } from '../app/types';

/** 发送消息的可选项：提及、图片附件、引用回复 */
export interface SendOptions {
  mentions?: string[];
  mediaUrl?: string;
  replyTo?: string;
  reply?: ChatMessage['reply'];
}

interface ChatState {
  status: WsStatus;
  me: UserBrief | null;
  rooms: api.Room[];
  activeRoomId: string | null;
  /** 已通过 WS 订阅实时消息的房间（客户端订阅全部房间，非活跃房间也能收消息） */
  subscribedRoomIds: string[];
  /** 每房间未读消息数（非活跃房间收到新消息时累加，选中时清零） */
  unreadByRoom: Record<string, number>;
  /** 每房间未读 @我 数（橙色角标，独立于普通未读） */
  mentionByRoom: Record<string, number>;
  messagesByRoom: Record<string, api.RoomMessage[]>;
  /** 房间花名册（DB 全体成员 + 在线标记；member:left = 离线而非移除，QQ 式） */
  membersByRoom: Record<string, RoomMember[]>;
  /** 每个房间的历史是否已加载（用于展示"加载历史中…"） */
  historyLoadedRooms: Record<string, boolean>;
  /** 每个房间是否还有更早的历史（向上翻页按钮显隐） */
  hasMoreByRoom: Record<string, boolean>;
  /** 每个房间的最新一条消息摘要（侧栏预览用，实时更新） */
  previewByRoom: Record<string, { username: string; userId: string; text: string; createdAt: string }>;
  /** 正在加载更早历史的房间（按钮 loading 态） */
  loadingOlderRooms: Record<string, boolean>;
  loadingRooms: boolean;
  roomError: string | null;
  /** 连接失败提示（server 不可达时展示） */
  connectionError: string | null;
  connect: () => void;
  disconnect: () => void;
  refreshRooms: () => Promise<void>;
  createRoom: (name: string) => Promise<api.Room | null>;
  joinRoomByCode: (code: string) => Promise<api.Room | null>;
  selectRoom: (roomId: string, forceReload?: boolean) => Promise<void>;
  loadOlderMessages: (roomId: string) => Promise<void>;
  loadRoomPreviews: () => Promise<void>;
  deleteRoom: (roomId: string) => void;
  leaveActiveRoom: () => Promise<void>;
  kickMember: (roomId: string, userId: string) => void;
  muteMember: (roomId: string, userId: string, minutes: number) => void;
  unmuteMember: (roomId: string, userId: string) => void;
  recallMessage: (roomId: string, messageId: string) => void;
  sendMessage: (text: string, opts?: SendOptions) => void;
  clearRoomError: () => void;
}

let socket: ChatSocket | null = null;
/** 订阅看门狗：连接开着但还有本地房间未订阅成功时，每 2s 补发 room:join 自愈 */
let subWatchdog: ReturnType<typeof setInterval> | null = null;

function startSubWatchdog(): void {
  if (subWatchdog) return;
  subWatchdog = setInterval(() => {
    const { status, subscribedRoomIds, rooms } = useChat.getState();
    if (status === 'open') {
      // 补订所有本地存在但尚未订阅的房间（重连/新加入房间后自愈）
      for (const r of rooms) {
        if (!subscribedRoomIds.includes(r.id)) {
          socket?.send({ type: 'room:join', payload: { roomId: r.id } });
        }
      }
    }
    // 发送超时自愈：消息发出 5s 仍未确认且连接显示 open → 连接疑似半开（TCP 假活），强制重连
    if (status === 'open' && pendingSends.some((p) => Date.now() - p.at > 5000)) {
      socket?.forceReconnect();
    }
  }, 2000);
}

function stopSubWatchdog(): void {
  if (subWatchdog) {
    clearInterval(subWatchdog);
    subWatchdog = null;
  }
}

function subscribeRoom(roomId: string): void {
  socket?.send({ type: 'room:join', payload: { roomId } });
}

function unsubscribeRoom(roomId: string): void {
  socket?.send({ type: 'room:leave', payload: { roomId } });
}

/** 订阅本地房间列表里的全部房间（hello:ok 后与看门狗共同保证最终一致） */
function subscribeAllRooms(): void {
  const { rooms, subscribedRoomIds } = useChat.getState();
  for (const r of rooms) {
    if (!subscribedRoomIds.includes(r.id)) subscribeRoom(r.id);
  }
}

/** 从本地移除房间（离开/被删/失效）：清理缓存并退订 WS */
function removeRoomLocal(roomId: string): void {
  unsubscribeRoom(roomId);
  useChat.setState((s) => {
    const rooms = s.rooms.filter((r) => r.id !== roomId);
    const messagesByRoom = { ...s.messagesByRoom };
    const membersByRoom = { ...s.membersByRoom };
    const unreadByRoom = { ...s.unreadByRoom };
    const mentionByRoom = { ...s.mentionByRoom };
    const previewByRoom = { ...s.previewByRoom };
    delete messagesByRoom[roomId];
    delete membersByRoom[roomId];
    delete unreadByRoom[roomId];
    delete mentionByRoom[roomId];
    delete previewByRoom[roomId];
    const wasActive = s.activeRoomId === roomId;
    return {
      rooms,
      messagesByRoom,
      membersByRoom,
      unreadByRoom,
      mentionByRoom,
      previewByRoom,
      activeRoomId: wasActive ? (rooms[0]?.id ?? null) : s.activeRoomId,
      subscribedRoomIds: s.subscribedRoomIds.filter((r) => r !== roomId),
    };
  });
}

/** 乐观发送队列：roomId -> {tempId, at}（用于 message:new 按序校正 + 超时强制重连检测） */
const pendingSends: { roomId: string; tempId: string; at: number }[] = [];
let pendingSeq = 0;

function appendPending(roomId: string, tempId: string): void {
  pendingSends.push({ roomId, tempId, at: Date.now() });
}

/** 移除该房间最早的乐观消息（对应一条已确认的 message:new），返回其 tempId */
function shiftPending(roomId: string): string | null {
  const i = pendingSends.findIndex((p) => p.roomId === roomId);
  if (i < 0) return null;
  const [p] = pendingSends.splice(i, 1);
  return p.tempId;
}

function clearPending(): void {
  pendingSends.length = 0;
}

/** 待发送队列：订阅未就绪时先排队（可多条），room:joined 后按序自动发出（游戏内呼出发送场景） */
let queuedSends: { roomId: string; text: string; opts?: SendOptions }[] = [];

/** 乐观上屏：把用户刚发的消息立即显示（pending 标记），服务器确认后校正 */
function appendOptimistic(roomId: string, text: string, opts?: SendOptions): void {
  const me = useChat.getState().me;
  if (!me) return;
  const tempId = `tmp-${Date.now()}-${++pendingSeq}`;
  appendPending(roomId, tempId);
  // 提及快照仅带 id：高亮在确认消息上由服务器快照完成，乐观期先不做用户名匹配
  const mentionRefs = (opts?.mentions ?? []).filter((id) => id !== me.id).map((id) => ({ id, username: '' }));
  useChat.setState((s) => ({
    messagesByRoom: {
      ...s.messagesByRoom,
      [roomId]: [
        ...(s.messagesByRoom[roomId] ?? []),
        {
          id: tempId,
          roomId,
          userId: me.id,
          username: me.username,
          avatarUrl: me.avatarUrl ?? null,
          text,
          createdAt: new Date().toISOString(),
          mentions: mentionRefs,
          kind: opts?.mediaUrl ? 'image' : 'text',
          mediaUrl: opts?.mediaUrl ?? null,
          reply: opts?.reply,
          pending: true,
        },
      ],
    },
  }));
}

/** 真正发送（不负责乐观上屏，由调用方决定） */
function doSend(roomId: string, text: string, opts?: SendOptions): void {
  const ok = socket?.send({ type: 'message:send', payload: { roomId, text, mentions: opts?.mentions, mediaUrl: opts?.mediaUrl, replyTo: opts?.replyTo } });
  if (ok) playSendSound(useSettings.getState().soundEnabled);
}

export const useChat = create<ChatState>()((set, get) => ({
  status: 'idle',
  me: null,
  rooms: [],
  activeRoomId: null,
  subscribedRoomIds: [],
  unreadByRoom: {},
  mentionByRoom: {},
  messagesByRoom: {},
  membersByRoom: {},
  historyLoadedRooms: {},
  hasMoreByRoom: {},
  previewByRoom: {},
  loadingOlderRooms: {},
  loadingRooms: false,
  roomError: null,
  connectionError: null,

  connect: () => {
    // 幂等：已在连接/已连接则不重复建连（React StrictMode 双挂载安全）
    const cur = get().status;
    if (cur === 'open' || cur === 'connecting' || cur === 'reconnecting') return;
    const { token } = useAuth.getState();
    if (!token) return;
    if (socket) socket.close();

    socket = new ChatSocket();
    socket.onStatus((status) => {
      set({ status });
      if (status === 'open') {
        set({ connectionError: null });
        // 关键：每次（重）连接都必须清空订阅状态——否则重连时 subscribedRoomIds
        // 残留旧房间 id，subscribeAllRooms 会认为已订阅而跳过 room:join，导致新连接
        // 在服务器侧没有订阅（发送/收消息都失效）
        set({ subscribedRoomIds: [] });
        socket?.send({ type: 'hello', payload: { token } });
      } else if (status === 'reconnecting') {
        // 连接抖动：未确认的乐观消息可能已发送/未发送，全部清除（含排队消息），
        // 由 hello:ok 后的历史重载兜底（已发送的会从历史回来）
        clearPending();
        queuedSends = [];
        set((s) => ({
          subscribedRoomIds: [],
          messagesByRoom: Object.fromEntries(
            Object.entries(s.messagesByRoom).map(([rid, msgs]) => [rid, msgs.filter((m) => !m.pending)]),
          ),
          // 重置历史标记：重连后 selectRoom 会重新拉取历史，
          // 把断开期间已入库的消息补回来（否则本地会永久丢消息）
          historyLoadedRooms: {},
        }));
        set({
          connectionError: `无法连接服务器${socket?.lastError ? `（${socket.lastError}）` : ''}。请确认服务器地址正确且服务器已运行`,
        });
      } else if (status === 'closed') {
        set({ connectionError: null });
      }
    });
    socket.onMessage((msg) => {
      const state = get();
      switch (msg.type) {
        case 'hello:ok':
          set({ me: msg.payload.me });
          // 好友列表/申请与房间并行加载
          void useFriends.getState().load();
          // 登录后加载房间列表，并订阅全部房间（refreshRooms 失败也要重订阅）
          void get()
            .refreshRooms()
            .then(() => void get().loadRoomPreviews())
            .catch(() => undefined)
            .then(() => {
              subscribeAllRooms();
              const active = get().activeRoomId;
              if (active) {
                // 重连后强制重载活跃房间历史（reconnecting 时已重置标记），
                // 把断开期间已入库的消息补回来，避免本地永久丢消息
                void get().selectRoom(active, true);
              }
            });
          break;
        case 'room:joined':
          set((s) => ({
            subscribedRoomIds: s.subscribedRoomIds.includes(msg.payload.roomId)
              ? s.subscribedRoomIds
              : [...s.subscribedRoomIds, msg.payload.roomId],
            membersByRoom: { ...s.membersByRoom, [msg.payload.roomId]: msg.payload.members },
          }));
          // 订阅就绪：把排队的该房间消息按序发出（自动选房/订阅未就绪时排队的）
          {
            const ready = queuedSends.filter((q) => q.roomId === msg.payload.roomId);
            if (ready.length > 0) {
              queuedSends = queuedSends.filter((q) => q.roomId !== msg.payload.roomId);
              for (const q of ready) doSend(q.roomId, q.text, q.opts);
            }
          }
          break;
        case 'member:joined':
          set((s) => {
            const members = s.membersByRoom[msg.payload.roomId];
            if (!members) return s;
            // 已在花名册（离线成员上线）→ 置为在线并刷新资料；新成员 → 追加
            const existing = members.some((m) => m.id === msg.payload.member.id);
            const next = existing
              ? members.map((m) => (m.id === msg.payload.member.id ? { ...m, ...msg.payload.member, online: true } : m))
              : [...members, { ...msg.payload.member, online: true }];
            return { membersByRoom: { ...s.membersByRoom, [msg.payload.roomId]: next } };
          });
          break;
        case 'member:left':
          set((s) => {
            const members = s.membersByRoom[msg.payload.roomId];
            if (!members) return s;
            // 离线 ≠ 退房：成员仍在花名册，仅标记离线（QQ 式置灰）
            return {
              membersByRoom: {
                ...s.membersByRoom,
                [msg.payload.roomId]: members.map((m) => (m.id === msg.payload.userId ? { ...m, online: false } : m)),
              },
            };
          });
          break;
        case 'room:deleted': {
          // 房主删除了房间：从本地移除（含退订），若正活跃则切到下一个房间
          removeRoomLocal(msg.payload.roomId);
          if (get().activeRoomId) void get().selectRoom(get().activeRoomId!);
          break;
        }
        case 'member:kicked': {
          const { roomId, userId } = msg.payload;
          if (userId === state.me?.id) {
            // 我被移出房间：本地清理 + 自动切换 + 明确提示
            removeRoomLocal(roomId);
            set({ roomError: '你已被房主移出该房间' });
            if (get().activeRoomId) void get().selectRoom(get().activeRoomId!);
          } else {
            set((s) => {
              const members = s.membersByRoom[roomId];
              if (!members) return s;
              return { membersByRoom: { ...s.membersByRoom, [roomId]: members.filter((m) => m.id !== userId) } };
            });
          }
          break;
        }
        case 'member:muted':
        case 'member:unmuted':
          set((s) => {
            const members = s.membersByRoom[msg.payload.roomId];
            if (!members) return s;
            const mutedUntil = msg.type === 'member:muted' ? msg.payload.mutedUntil : null;
            return {
              membersByRoom: {
                ...s.membersByRoom,
                [msg.payload.roomId]: members.map((m) =>
                  m.id === msg.payload.userId ? { ...m, mutedUntil } : m,
                ),
              },
            };
          });
          break;
        case 'message:new': {
          set((s) => {
            // 自己发出的消息：先移除对应的乐观占位，再追加服务器确认版本（避免重复）
            let list = s.messagesByRoom[msg.payload.roomId] ?? [];
            if (msg.payload.message.userId === s.me?.id) {
              const tempId = shiftPending(msg.payload.roomId);
              if (tempId) list = list.filter((m) => m.id !== tempId);
            }
            return {
              messagesByRoom: { ...s.messagesByRoom, [msg.payload.roomId]: [...list, msg.payload.message] },
            };
          });
          const isMine = msg.payload.message.userId === state.me?.id;
          const active = get().activeRoomId;
          // @我：非自己消息且提及含我 → 通知中心 + 非活跃房间累计 @未读
          const mentionedMe = !isMine && (msg.payload.message.mentions ?? []).some((m) => m.id === state.me?.id);
          if (mentionedMe) {
            const roomName = get().rooms.find((r) => r.id === msg.payload.roomId)?.name ?? '房间';
            useNotifications.getState().push({
              kind: 'mention',
              text: `${msg.payload.message.username} 在 #${roomName} 里提到了你`,
              roomId: msg.payload.roomId,
            });
            if (active !== msg.payload.roomId) {
              set((s) => ({
                mentionByRoom: {
                  ...s.mentionByRoom,
                  [msg.payload.roomId]: (s.mentionByRoom[msg.payload.roomId] ?? 0) + 1,
                },
              }));
            }
          }
          if (!isMine) {
            // 非活跃房间累加未读数；提示音只对别人的消息生效
            if (active !== msg.payload.roomId) {
              set((s) => ({
                unreadByRoom: {
                  ...s.unreadByRoom,
                  [msg.payload.roomId]: (s.unreadByRoom[msg.payload.roomId] ?? 0) + 1,
                },
              }));
            }
            playMessageSound(useSettings.getState().soundEnabled);
          }
          // 侧栏预览实时更新（多房间订阅使非活跃房间也能即时刷新）；图片消息显示占位文案
          set((s) => ({
            previewByRoom: {
              ...s.previewByRoom,
              [msg.payload.roomId]: {
                username: msg.payload.message.username,
                userId: msg.payload.message.userId,
                text: msg.payload.message.kind === 'image' ? '[图片]' : msg.payload.message.text,
                createdAt: msg.payload.message.createdAt,
              },
            },
          }));
          // Overlay 显示所有新消息（含自己发送的，便于游戏内确认消息已发出）
          const room = get().rooms.find((r) => r.id === msg.payload.roomId);
          void pushOverlayMessage(msg.payload.message, room?.name, isMine);
          break;
        }
        case 'message:recalled':
          set((s) => {
            const list = s.messagesByRoom[msg.payload.roomId];
            if (!list) return s;
            return {
              messagesByRoom: {
                ...s.messagesByRoom,
                [msg.payload.roomId]: list.map((m) =>
                  m.id === msg.payload.messageId ? { ...m, recalled: true, text: '', mediaUrl: null, mentions: [] } : m,
                ),
              },
            };
          });
          break;
        case 'friend:request':
        case 'friend:accepted':
        case 'friend:declined':
        case 'friend:removed':
        case 'presence:friend':
          // 好友域事件由 friends store 处理（chat socket 是唯一的 WS 通道）
          useFriends.getState().handleWs(msg);
          break;
        case 'error':
          // 服务器返回错误：清掉未确认的乐观占位与排队消息，避免"幽灵消息"卡在界面上
          clearPending();
          queuedSends = [];
          set((s) => ({
            messagesByRoom: Object.fromEntries(
              Object.entries(s.messagesByRoom).map(([rid, msgs]) => [rid, msgs.filter((m) => !m.pending)]),
            ),
          }));
          if (msg.payload.code === 'unauthorized') {
            useAuth.getState().logout();
          } else if (msg.payload.code === 'not_in_room') {
            const rid = msg.payload.roomId;
            if (rid) {
              // 房间已删除/不再是成员：从本地移除并自动切换（避免"你不是该房间成员"误导报错）
              const wasActive = get().activeRoomId === rid;
              removeRoomLocal(rid);
              if (get().activeRoomId) void get().selectRoom(get().activeRoomId!);
              if (wasActive) set({ roomError: '房间已删除或你已不在该房间，已自动切换。' });
            } else {
              set({ roomError: '你不是该房间成员' });
            }
          } else if (msg.payload.code === 'only_owner') {
            set({ roomError: '只有房主才能删除房间' });
          } else if (msg.payload.code === 'rate_limited') {
            set({ roomError: '发送过于频繁，请稍候再试' });
          } else if (msg.payload.code === 'muted') {
            const until = msg.payload.mutedUntil ? new Date(msg.payload.mutedUntil) : null;
            const mins = until ? Math.max(1, Math.ceil((until.getTime() - Date.now()) / 60000)) : null;
            set({ roomError: mins ? `你已被禁言，约 ${mins} 分钟后恢复` : '你已被禁言' });
          } else if (msg.payload.code === 'room_not_found') {
            set({ roomError: '房间不存在或已被删除' });
          }
          break;
        default:
          break;
      }
    });

    socket.connect(wsUrlOf(useSettings.getState().serverUrl));
    startSubWatchdog();
  },

  disconnect: () => {
    stopSubWatchdog();
    socket?.close();
    socket = null;
    queuedSends = [];
    // 保留 me（认证身份，与连接状态无关）与 rooms/messages：
    // 清掉 me 会导致断开期间自己的消息被渲染到左边、成员列表失去自身定位
    set({ status: 'closed', subscribedRoomIds: [] });
  },

  refreshRooms: async () => {
    const { token } = useAuth.getState();
    if (!token) return;
    set({ loadingRooms: true });
    try {
      const { rooms } = await api.listRooms(token);
      set({ rooms });
      // 默认选中第一个房间
      if (!get().activeRoomId && rooms.length > 0) {
        await get().selectRoom(rooms[0].id);
      }
    } catch (e) {
      set({ roomError: e instanceof Error ? e.message : '加载房间失败' });
    } finally {
      set({ loadingRooms: false });
    }
  },

  createRoom: async (name) => {
    const { token } = useAuth.getState();
    if (!token) {
      set({ roomError: '未登录或处于离线模式，无法创建房间。请先连接服务器并登录。' });
      return null;
    }
    try {
      const { room } = await api.createRoom(token, name);
      set((s) => ({ rooms: [room, ...s.rooms] }));
      await get().selectRoom(room.id);
      return room;
    } catch (e) {
      set({ roomError: e instanceof Error ? e.message : '创建房间失败' });
      return null;
    }
  },

  joinRoomByCode: async (code) => {
    const { token } = useAuth.getState();
    if (!token) {
      set({ roomError: '未登录或处于离线模式，无法加入房间。请先连接服务器并登录。' });
      return null;
    }
    try {
      const { room } = await api.joinRoomByCode(token, code);
      set((s) => (s.rooms.some((r) => r.id === room.id) ? s : { rooms: [room, ...s.rooms] }));
      await get().selectRoom(room.id);
      return room;
    } catch (e) {
      set({ roomError: e instanceof Error ? e.message : '加入房间失败' });
      return null;
    }
  },

  selectRoom: async (roomId, forceReload = false) => {
    const { token } = useAuth.getState();
    if (!token) return;
    // 选中即清零未读（普通 + @我）；room:join 幂等（已订阅时服务端也会回执），看门狗兜底
    set((s) => ({
      activeRoomId: roomId,
      unreadByRoom: { ...s.unreadByRoom, [roomId]: 0 },
      mentionByRoom: { ...s.mentionByRoom, [roomId]: 0 },
    }));
    subscribeRoom(roomId);
    // 加载历史（首次或 forceReload——重连后强制重拉，补齐断开期间的消息）
    if (forceReload || (!(get().messagesByRoom[roomId]?.length) && !get().historyLoadedRooms[roomId])) {
      try {
        const { messages, hasMore } = await api.roomMessages(token, roomId, { limit: 50 });
        set((s) => ({
          messagesByRoom: { ...s.messagesByRoom, [roomId]: messages },
          historyLoadedRooms: { ...s.historyLoadedRooms, [roomId]: true },
          hasMoreByRoom: { ...s.hasMoreByRoom, [roomId]: hasMore },
        }));
      } catch (e) {
        set((s) => ({ historyLoadedRooms: { ...s.historyLoadedRooms, [roomId]: true }, roomError: e instanceof Error ? e.message : '加载历史失败' }));
      }
    }
  },

  loadOlderMessages: async (roomId) => {
    const { token } = useAuth.getState();
    if (!token) return;
    const { hasMoreByRoom, loadingOlderRooms, messagesByRoom } = get();
    if (!hasMoreByRoom[roomId] || loadingOlderRooms[roomId]) return;
    // 游标 = 当前最早一条已确认消息（乐观占位总在末尾，不影响）
    const oldest = messagesByRoom[roomId]?.find((m) => !m.pending);
    if (!oldest) return;
    set((s) => ({ loadingOlderRooms: { ...s.loadingOlderRooms, [roomId]: true } }));
    try {
      const { messages, hasMore } = await api.roomMessages(token, roomId, { before: oldest.id, limit: 50 });
      set((s) => {
        const existing = new Set((s.messagesByRoom[roomId] ?? []).map((m) => m.id));
        const fresh = messages.filter((m) => !existing.has(m.id));
        return {
          messagesByRoom: { ...s.messagesByRoom, [roomId]: [...fresh, ...(s.messagesByRoom[roomId] ?? [])] },
          hasMoreByRoom: { ...s.hasMoreByRoom, [roomId]: hasMore },
          historyLoadedRooms: { ...s.historyLoadedRooms, [roomId]: true },
        };
      });
    } catch (e) {
      set({ roomError: e instanceof Error ? e.message : '加载更早消息失败' });
    } finally {
      set((s) => ({ loadingOlderRooms: { ...s.loadingOlderRooms, [roomId]: false } }));
    }
  },

  // 为所有房间拉取最新一条消息做侧栏预览（limit=1，进入应用时一次性补齐，
  // 之后由 message:new 实时更新；已删除/失效房间静默忽略）
  loadRoomPreviews: async () => {
    const { token } = useAuth.getState();
    if (!token) return;
    const rooms = get().rooms;
    await Promise.all(
      rooms.map(async (r) => {
        try {
          const { messages } = await api.roomMessages(token, r.id, { limit: 1 });
          const last = messages[messages.length - 1];
          if (!last) return;
          set((s) => ({
            previewByRoom: {
              ...s.previewByRoom,
              [r.id]: { username: last.username, userId: last.userId, text: last.kind === 'image' ? '[图片]' : last.text, createdAt: last.createdAt },
            },
          }));
        } catch {
          // 单个房间失败不影响其他
        }
      }),
    );
  },

  leaveActiveRoom: async () => {
    const { token } = useAuth.getState();
    const { activeRoomId } = get();
    if (!token || !activeRoomId) return;
    try {
      await api.leaveRoom(token, activeRoomId);
      // removeRoomLocal 内含退订 WS + 本地清理 + 自动切换到下一个房间
      removeRoomLocal(activeRoomId);
      if (get().activeRoomId) await get().selectRoom(get().activeRoomId!);
    } catch (e) {
      set({ roomError: e instanceof Error ? e.message : '离开房间失败' });
    }
  },

  deleteRoom: (roomId) => {
    const { status } = get();
    if (status !== 'open' || !socket) {
      set({ roomError: '连接未就绪，无法删除房间。请确认已连接服务器。' });
      return;
    }
    // 服务端校验房主权限，成功后广播 room:deleted（各端自行移除）
    socket.send({ type: 'room:delete', payload: { roomId } });
  },

  kickMember: (roomId, userId) => {
    const { status } = get();
    if (status !== 'open' || !socket) {
      set({ roomError: '连接未就绪，无法操作。请确认已连接服务器。' });
      return;
    }
    // 服务端校验房主权限，成功后广播 member:kicked（各端含被踢者自行清理）
    socket.send({ type: 'member:kick', payload: { roomId, userId } });
  },

  muteMember: (roomId, userId, minutes) => {
    const { status } = get();
    if (status !== 'open' || !socket) {
      set({ roomError: '连接未就绪，无法操作。请确认已连接服务器。' });
      return;
    }
    // 服务端校验房主权限与时长，成功后广播 member:muted（花名册带 mutedUntil）
    socket.send({ type: 'member:mute', payload: { roomId, userId, minutes } });
  },

  unmuteMember: (roomId, userId) => {
    const { status } = get();
    if (status !== 'open' || !socket) {
      set({ roomError: '连接未就绪，无法操作。请确认已连接服务器。' });
      return;
    }
    socket.send({ type: 'member:unmute', payload: { roomId, userId } });
  },

  recallMessage: (roomId, messageId) => {
    const { status } = get();
    if (status !== 'open' || !socket) {
      set({ roomError: '连接未就绪，无法操作。请确认已连接服务器。' });
      return;
    }
    // 服务端校验（发送者本人或房主），成功后广播 message:recalled（各端内容清空）
    socket.send({ type: 'message:recall', payload: { roomId, messageId } });
  },

  sendMessage: (text, opts) => {
    const trimmed = text.trim();
    if (!trimmed && !opts?.mediaUrl) return;
    const { activeRoomId, subscribedRoomIds, status, rooms } = get();
    let target = activeRoomId;

    // 未选择房间：游戏内呼出发送时自动选中第一个房间（并排队，订阅建立后发出）
    if (!target) {
      if (rooms.length === 0) {
        set({ roomError: '还没有房间，请先创建或加入房间再发送。' });
        return;
      }
      target = rooms[0].id;
      set({ activeRoomId: target });
      subscribeRoom(target);
      void get().selectRoom(target);
    }

    // 订阅/连接未就绪：乐观上屏 + 排队，就绪（room:joined）后自动发送
    if (status !== 'open' || !subscribedRoomIds.includes(target)) {
      appendOptimistic(target, trimmed, opts);
      queuedSends.push({ roomId: target, text: trimmed, opts });
      set({ roomError: null });
      return;
    }

    doSend(target, trimmed, opts);
    appendOptimistic(target, trimmed, opts);
  },

  clearRoomError: () => set({ roomError: null }),
}));
