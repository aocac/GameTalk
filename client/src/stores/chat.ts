import { create } from 'zustand';
import { ChatSocket } from '../app/ws';
import { playMessageSound, playSendSound } from '../app/audio';
import { useSettings } from '../app/settings';
import { useAuth } from './auth';
import { wsUrlOf } from '../app/settings';
import * as api from '../app/api';
import { pushOverlayMessage } from '../app/gameMode';
import type { UserBrief, WsStatus } from '../app/types';

interface ChatState {
  status: WsStatus;
  me: UserBrief | null;
  rooms: api.Room[];
  activeRoomId: string | null;
  /** 已通过 WS 订阅实时消息的房间 */
  subscribedRoomId: string | null;
  messagesByRoom: Record<string, api.RoomMessage[]>;
  membersByRoom: Record<string, UserBrief[]>;
  /** 每个房间的历史是否已加载（用于展示"加载历史中…"） */
  historyLoadedRooms: Record<string, boolean>;
  loadingRooms: boolean;
  roomError: string | null;
  /** 连接失败提示（server 不可达时展示） */
  connectionError: string | null;
  connect: () => void;
  disconnect: () => void;
  refreshRooms: () => Promise<void>;
  createRoom: (name: string) => Promise<api.Room | null>;
  joinRoomByCode: (code: string) => Promise<api.Room | null>;
  selectRoom: (roomId: string) => Promise<void>;
  leaveActiveRoom: () => Promise<void>;
  deleteActiveRoom: () => Promise<void>;
  sendMessage: (text: string) => void;
  clearRoomError: () => void;
}

let socket: ChatSocket | null = null;
/** 订阅看门狗：连接开着但活跃房间订阅缺失时，每 2s 补发 room:join 自愈 */
let subWatchdog: ReturnType<typeof setInterval> | null = null;

function startSubWatchdog(): void {
  if (subWatchdog) return;
  subWatchdog = setInterval(() => {
    const { status, activeRoomId, subscribedRoomId, rooms } = useChat.getState();
    if (status === 'open' && activeRoomId && subscribedRoomId !== activeRoomId) {
      // 只补订本地列表里存在的房间（防止对已删除房间反复 join）
      if (rooms.some((r) => r.id === activeRoomId)) {
        socket?.send({ type: 'room:join', payload: { roomId: activeRoomId } });
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

function wsRoomSwitch(roomId: string | null): void {
  const s = socket;
  if (!s) return;
  // 只 join 本地房间列表里存在的房间：避免对已删除/失效的房间发 join 被拒
  if (roomId && !useChat.getState().rooms.some((r) => r.id === roomId)) return;
  const cur = useChat.getState().subscribedRoomId;
  if (cur && cur !== roomId) s.send({ type: 'room:leave', payload: { roomId: cur } });
  if (roomId && roomId !== cur) s.send({ type: 'room:join', payload: { roomId } });
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

/** 待发送队列：订阅未就绪时先排队，room:joined 后自动发出（游戏内呼出发送场景） */
let queuedSend: { roomId: string; text: string } | null = null;

/** 乐观上屏：把用户刚发的消息立即显示（pending 标记），服务器确认后校正 */
function appendOptimistic(roomId: string, text: string): void {
  const me = useChat.getState().me;
  if (!me) return;
  const tempId = `tmp-${Date.now()}-${++pendingSeq}`;
  appendPending(roomId, tempId);
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
          pending: true,
        },
      ],
    },
  }));
}

/** 真正发送（不负责乐观上屏，由调用方决定） */
function doSend(roomId: string, text: string): void {
  const ok = socket?.send({ type: 'message:send', payload: { roomId, text } });
  if (ok) playSendSound(useSettings.getState().soundEnabled);
}

export const useChat = create<ChatState>()((set, get) => ({
  status: 'idle',
  me: null,
  rooms: [],
  activeRoomId: null,
  subscribedRoomId: null,
  messagesByRoom: {},
  membersByRoom: {},
  historyLoadedRooms: {},
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
        // 关键：每次（重）连接都必须清空订阅状态——否则重连时 subscribedRoomId
        // 残留旧房间 id，wsRoomSwitch 会认为已订阅而跳过 room:join，导致新连接
        // 在服务器侧没有订阅（发送/收消息都失效）
        set({ subscribedRoomId: null });
        socket?.send({ type: 'hello', payload: { token } });
      } else if (status === 'reconnecting') {
        // 连接抖动：未确认的乐观消息可能已发送/未发送，全部清除，
        // 由 hello:ok 后的历史重载兜底（已发送的会从历史回来）
        clearPending();
        set((s) => ({
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
          // 登录后加载房间列表，并订阅当前活跃房间（refreshRooms 失败也要重订阅）
          void get()
            .refreshRooms()
            .catch(() => undefined)
            .then(() => {
              const active = get().activeRoomId;
              if (active) {
                wsRoomSwitch(active);
                // 重连后重新加载活跃房间历史（historyLoadedRooms 已在 reconnecting 时重置），
                // 把断开期间已入库的消息补回来，避免本地永久丢消息
                void get().selectRoom(active);
              }
            });
          break;
        case 'room:joined':
          set((s) => ({
            subscribedRoomId: msg.payload.roomId,
            membersByRoom: { ...s.membersByRoom, [msg.payload.roomId]: msg.payload.members },
          }));
          // 订阅就绪：若有待发送消息（自动选房/订阅未就绪时排队的），立即发出
          if (queuedSend && queuedSend.roomId === msg.payload.roomId) {
            const q = queuedSend;
            queuedSend = null;
            doSend(q.roomId, q.text);
          }
          break;
        case 'member:joined':
          if (msg.payload.roomId === state.subscribedRoomId) {
            set((s) => {
              const members = s.membersByRoom[msg.payload.roomId] ?? [];
              if (members.some((m) => m.id === msg.payload.member.id)) return s;
              return { membersByRoom: { ...s.membersByRoom, [msg.payload.roomId]: [...members, msg.payload.member] } };
            });
          }
          break;
        case 'member:left':
          if (msg.payload.roomId === state.subscribedRoomId) {
            set((s) => ({
              membersByRoom: {
                ...s.membersByRoom,
                [msg.payload.roomId]: (s.membersByRoom[msg.payload.roomId] ?? []).filter(
                  (m) => m.id !== msg.payload.userId,
                ),
              },
            }));
          }
          break;
        case 'room:deleted': {
          // 房主删除了房间：从本地移除，若正活跃则切到下一个房间
          const rid = msg.payload.roomId;
          set((s) => {
            const rooms = s.rooms.filter((r) => r.id !== rid);
            const messagesByRoom = { ...s.messagesByRoom };
            const membersByRoom = { ...s.membersByRoom };
            delete messagesByRoom[rid];
            delete membersByRoom[rid];
            const wasActive = s.activeRoomId === rid;
            return {
              rooms,
              messagesByRoom,
              membersByRoom,
              activeRoomId: wasActive ? (rooms[0]?.id ?? null) : s.activeRoomId,
              subscribedRoomId: wasActive ? null : s.subscribedRoomId,
            };
          });
          if (get().activeRoomId) void get().selectRoom(get().activeRoomId!);
          break;
        }
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
          if (!isMine && (active === null || active === msg.payload.roomId)) {
            playMessageSound(useSettings.getState().soundEnabled);
            void pushOverlayMessage(msg.payload.message);
          }
          break;
        }
        case 'error':
          // 服务器返回错误：清掉未确认的乐观占位与排队消息，避免"幽灵消息"卡在界面上
          clearPending();
          queuedSend = null;
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
              set((s) => {
                const rooms = s.rooms.filter((r) => r.id !== rid);
                const messagesByRoom = { ...s.messagesByRoom };
                const membersByRoom = { ...s.membersByRoom };
                delete messagesByRoom[rid];
                delete membersByRoom[rid];
                return {
                  rooms,
                  messagesByRoom,
                  membersByRoom,
                  activeRoomId: wasActive ? (rooms[0]?.id ?? null) : s.activeRoomId,
                  subscribedRoomId: wasActive ? null : s.subscribedRoomId,
                };
              });
              if (get().activeRoomId) void get().selectRoom(get().activeRoomId!);
              if (wasActive) set({ roomError: '房间已删除或你已不在该房间，已自动切换。' });
            } else {
              set({ roomError: '你不是该房间成员' });
            }
          } else if (msg.payload.code === 'only_owner') {
            set({ roomError: '只有房主才能删除房间' });
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
    // 保留 rooms/messages 等状态，便于重新连接后恢复订阅
    set({ status: 'closed', me: null, subscribedRoomId: null });
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

  selectRoom: async (roomId) => {
    const { token } = useAuth.getState();
    if (!token) return;
    set({ activeRoomId: roomId });
    wsRoomSwitch(roomId);
    // 加载历史（若尚未加载）
    if (!(get().messagesByRoom[roomId]?.length) && !get().historyLoadedRooms[roomId]) {
      try {
        const { messages } = await api.roomMessages(token, roomId, { limit: 50 });
        set((s) => ({
          messagesByRoom: { ...s.messagesByRoom, [roomId]: messages },
          historyLoadedRooms: { ...s.historyLoadedRooms, [roomId]: true },
        }));
      } catch (e) {
        set((s) => ({ historyLoadedRooms: { ...s.historyLoadedRooms, [roomId]: true }, roomError: e instanceof Error ? e.message : '加载历史失败' }));
      }
    }
  },

  leaveActiveRoom: async () => {
    const { token } = useAuth.getState();
    const { activeRoomId } = get();
    if (!token || !activeRoomId) return;
    try {
      await api.leaveRoom(token, activeRoomId);
      // 先退订 WS，再切到下一个房间
      socket?.send({ type: 'room:leave', payload: { roomId: activeRoomId } });
      set((s) => {
        const rooms = s.rooms.filter((r) => r.id !== activeRoomId);
        const messagesByRoom = { ...s.messagesByRoom };
        const membersByRoom = { ...s.membersByRoom };
        delete messagesByRoom[activeRoomId];
        delete membersByRoom[activeRoomId];
        return {
          rooms,
          messagesByRoom,
          membersByRoom,
          activeRoomId: rooms[0]?.id ?? null,
          subscribedRoomId: null,
        };
      });
      if (get().activeRoomId) await get().selectRoom(get().activeRoomId!);
    } catch (e) {
      set({ roomError: e instanceof Error ? e.message : '离开房间失败' });
    }
  },

  deleteActiveRoom: async () => {
    const { activeRoomId, status } = get();
    if (!activeRoomId) return;
    if (status !== 'open' || !socket) {
      set({ roomError: '连接未就绪，无法删除房间。请确认已连接服务器。' });
      return;
    }
    // 通过 WS 发送删除请求：服务端校验房主权限，成功后广播 room:deleted
    socket.send({ type: 'room:delete', payload: { roomId: activeRoomId } });
  },

  sendMessage: (text) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const { activeRoomId, subscribedRoomId, status, rooms } = get();
    let target = activeRoomId;

    // 未选择房间：游戏内呼出发送时自动选中第一个房间（并排队，订阅建立后发出）
    if (!target) {
      if (rooms.length === 0) {
        set({ roomError: '还没有房间，请先创建或加入房间再发送。' });
        return;
      }
      target = rooms[0].id;
      set({ activeRoomId: target });
      wsRoomSwitch(target);
      void get().selectRoom(target);
    }

    // 订阅/连接未就绪：乐观上屏 + 排队，就绪（room:joined）后自动发送
    if (target !== subscribedRoomId || status !== 'open') {
      appendOptimistic(target, trimmed);
      queuedSend = { roomId: target, text: trimmed };
      set({ roomError: null });
      return;
    }

    doSend(target, trimmed);
    appendOptimistic(target, trimmed);
  },

  clearRoomError: () => set({ roomError: null }),
}));
