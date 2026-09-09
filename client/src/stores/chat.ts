import { create } from 'zustand';
import { ChatSocket } from '../app/ws';
import { playMessageSound, playMentionSound, playSendSound } from '../app/audio';
import { useSettings, DEFAULT_HOTKEY } from '../app/settings';
import { useAuth } from './auth';
import { useFriends } from './friends';
import { wsUrlOf } from '../app/settings';
import * as api from '../app/api';
import { pushOverlayEdit, pushOverlayMessage, pushOverlayRecall } from '../app/gameMode';
import { ScreenShareManager } from '../app/screenShare';
import type { ChatMessage, DmMessage, RoomMember, UserBrief, WsStatus } from '../app/types';

/** 通知点击跳转的会话定位（应用窗口获得焦点时消费） */
export type NotifyTarget = { kind: 'room' | 'dm'; id: string } | null;

/** Windows 系统通知（档位判断在调用方；浏览器/无权限环境静默忽略）。
 *  target：点击通知（聚焦应用窗口）后应跳转到的会话 */
async function sendWindowsNotify(title: string, body: string, target: NotifyTarget): Promise<void> {
  try {
    const { isPermissionGranted, requestPermission, sendNotification } = await import('@tauri-apps/plugin-notification');
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === 'granted';
    if (granted && body) {
      // 窗口已在前台时点击通知不产生 focus 变化（拿不到点击事件），记录目标只会在之后
      // 某次无关的聚焦时误跳转——因此只在窗口不在前台时记录
      const focused = typeof document !== 'undefined' && document.hasFocus();
      if (target && !focused) useChat.setState({ pendingNotifyTarget: target });
      sendNotification({ title, body });
    }
  } catch {
    // 非 Tauri 环境（浏览器调试）无插件，忽略
  }
}

/** 发送消息的可选项：提及、图片附件、引用回复 */
export interface SendOptions {
  mentions?: string[];
  mediaUrl?: string;
  /** 多图：一条消息携带多张（服务端落 media_urls，首图写 media_url 兼容旧端） */
  mediaUrls?: string[];
  replyTo?: string;
  reply?: ChatMessage['reply'];
  /** 表情消息标记：随媒体发送时置 kind='sticker'（渲染更小、不包气泡） */
  sticker?: boolean;
}

/** DM 消息 → 房间消息渲染形状（from 映射为 userId，渲染组件完全复用） */
function dmToRoomMessage(m: DmMessage): api.RoomMessage {
  return {
    id: m.id,
    roomId: '',
    userId: m.from,
    username: m.username,
    avatarUrl: m.avatarUrl ?? null,
    text: m.text,
    createdAt: m.createdAt,
    kind: m.kind,
    mediaUrl: m.mediaUrl ?? null,
    mediaUrls: m.mediaUrls,
    reply: m.reply,
    recalled: m.recalled,
    editedAt: m.editedAt,
    forwardedFromLabel: m.forwardedFromLabel ?? null,
  };
}

/** 账号世代：换账号时自增，迟到的旧账号请求响应据此丢弃（防跨账号数据串台） */
let accountGen = 0;

/** DM 会话键（乐观发送队列用，与房间 UUID 不冲突） */
function dmKey(peerId: string): string {
  return `dm:${peerId}`;
}

/**
 * 是否正在「看」这个房间：DM 打开时房间不算在看（否则在私聊里收到的房间消息
 * 不会计入未读、也不会弹通知，用户会静默漏消息）；窗口不在前台（最小化/托盘）同理。
 */
function isViewingRoom(roomId: string): boolean {
  const s = useChat.getState();
  return s.activeRoomId === roomId && !s.activeDmPeerId && s.mainWindowFocused;
}

/** 是否正在「看」这个私聊（窗口不在前台时同样不算，托盘期间的消息要计未读并弹通知） */
function isViewingDm(peerId: string): boolean {
  const s = useChat.getState();
  return s.activeDmPeerId === peerId && s.mainWindowFocused;
}

/** 历史重载时的合并：保留拉取期间经 WS 到达的新消息与仍在途的乐观消息（否则会被旧快照覆盖）。
 *  since = 发起请求的时刻：服务端返回为空时用它当基准，避免把历史残留消息「复活」 */
function mergeFetchedHistory(
  fetched: api.RoomMessage[],
  local: api.RoomMessage[] | undefined,
  since: string,
): api.RoomMessage[] {
  if (!local?.length) return fetched;
  const known = new Set(fetched.map((m) => m.id));
  const newestAt = fetched.length ? fetched[fetched.length - 1].createdAt : since;
  const extra = local.filter((m) => !known.has(m.id) && (m.pending || m.createdAt > newestAt));
  return extra.length ? [...fetched, ...extra] : fetched;
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
  previewByRoom: Record<string, { id: string; username: string; userId: string; text: string; createdAt: string }>;
  /** 正在加载更早历史的房间（按钮 loading 态） */
  loadingOlderRooms: Record<string, boolean>;
  loadingRooms: boolean;
  roomError: string | null;
  /** 连接失败提示（server 不可达时展示） */
  connectionError: string | null;
  /** 主窗口是否在前台：最小化/托盘时即使选中会话也要计未读并弹通知 */
  mainWindowFocused: boolean;
  // ============ 好友私聊（DM） ============
  /** 每个好友（peer）的 DM 消息（含自己的，userId=from） */
  dmMessages: Record<string, api.RoomMessage[]>;
  /** DM 历史是否已加载过 */
  dmHistoryLoaded: Record<string, boolean>;
  /** 每个会话是否还有更早历史 */
  dmHasMore: Record<string, boolean>;
  /** 每个会话未读数（非活跃时收到新 DM 累加，打开清零） */
  dmUnread: Record<string, number>;
  /** 每个会话最后一条消息摘要（侧栏私聊列表） */
  dmPreviews: Record<string, { id: string; userId: string; username: string; text: string; createdAt: string }>;
  /** 当前打开的 DM 会话（好友 userId）；与 activeRoomId 互斥表达「活跃会话」 */
  activeDmPeerId: string | null;
  /** 最近一条通知对应的会话：点击通知（窗口聚焦）后跳转，进入会话即清除 */
  pendingNotifyTarget: NotifyTarget;
  /** 主窗口获得焦点时调用：有待跳转通知则切换到对应会话 */
  consumePendingNotifyTarget: () => void;
  connect: () => void;
  disconnect: () => void;
  /** 换账号（登出/注册新号）时清空上一账号的房间/消息/选中态，防止越权请求与界面残留 */
  resetAccountState: () => void;
  refreshRooms: () => Promise<void>;
  createRoom: (name: string) => Promise<api.Room | null>;
  joinRoomByCode: (code: string) => Promise<api.Room | null>;
  selectRoom: (roomId: string, forceReload?: boolean) => Promise<void>;
  loadOlderMessages: (roomId: string) => Promise<void>;
  loadRoomPreviews: () => Promise<void>;
  deleteRoom: (roomId: string) => void;
  leaveRoom: (roomId: string) => Promise<void>;
  leaveActiveRoom: () => Promise<void>;
  kickMember: (roomId: string, userId: string) => void;
  muteMember: (roomId: string, userId: string, minutes: number) => void;
  unmuteMember: (roomId: string, userId: string) => void;
  recallMessage: (roomId: string, messageId: string) => void;
  sendMessage: (text: string, opts?: SendOptions, roomOverride?: string) => void;
  clearRoomError: () => void;
  /** 主窗口焦点变化（App 层 onFocusChanged 上报） */
  setMainWindowFocused: (focused: boolean) => void;
  openDm: (peerId: string) => Promise<void>;
  /** 删除好友时调用：若正查看与该好友的私聊，退出该会话并清理未读 */
  clearActiveDmIf: (peerId: string) => void;
  loadDmConversations: () => Promise<void>;
  loadOlderDmMessages: (peerId: string) => Promise<void>;
  sendDm: (text: string, opts?: SendOptions, peerOverride?: string) => void;
  recallDm: (messageId: string) => void;
  editMessage: (roomId: string, messageId: string, text: string) => void;
  editDm: (messageId: string, text: string) => void;
  /** 转发消息到目标会话（房间或好友私聊）；目标会话在线成员经既有广播通道实时收到 */
  forwardMessage: (source: 'room' | 'dm', messageId: string, target: { roomId?: string; userId?: string }) => void;
  /** 屏幕共享状态（按房间隔离；支持多人同时共享，shares 以 sharerId 为键） */
  screenShare: {
    /** 这些共享所属的房间（null = 无共享）；仅在该房间显示相关 UI */
    roomId: string | null;
    /** 我是否正在共享本房间屏幕 */
    selfSharing: boolean;
    /** 我共享的流是否包含音频（共享期间抑制本地提示音，避免回流进共享流） */
    selfSharingAudio: boolean;
    /** 其他人的共享：sharerId -> { 名称, 是否已加入观看, 远端流, ICE 连接状态, 是否在独立窗口观看 } */
    shares: Record<string, { name: string; watching: boolean; remoteStream: MediaStream | null; ice?: string; external?: boolean }>;
  };
  /** 开始共享当前房间的屏幕（WebRTC P2P） */
  startScreenShare: () => Promise<void>;
  /** 停止屏幕共享 */
  stopScreenShare: () => void;
  /** 主动加入观看指定用户的共享（先取自建 TURN 凭据再建接收连接） */
  watchScreenShare: (sharerId: string) => Promise<void>;
  /** 停止观看某个共享（释放该路 P2P，不通知共享者） */
  stopWatching: (sharerId: string) => void;
  /** 标记/清除「该共享正在独立观看窗中观看」（窗关闭时清除，横幅据此切换动作） */
  markShareExternal: (sharerId: string, external: boolean) => void;
  /** 内部：处理 screen:signal 信令 */
  handleScreenSignal: (from: string, roomId: string, data: unknown) => Promise<void>;
}

let socket: ChatSocket | null = null;
/** 订阅看门狗：连接开着但还有本地房间未订阅成功时，每 2s 补发 room:join 自愈 */
let subWatchdog: ReturnType<typeof setInterval> | null = null;
/** 当前房间的屏幕共享 P2P 会话管理器（随活跃会话切换而重置） */
let screenShareManager: ScreenShareManager | null = null;
/** 服务端 /api/turn 签发的自建 TURN 凭据缓存（服务端 1h 有效，提前 5 分钟刷新） */
let turnIceCache: { iceServers: api.TurnIceServer[]; expiry: number } | null = null;

/** 取自建 TURN 凭据（命中缓存即返回）；失败时回落缓存或空（仅 STUN/OpenRelay 兜底） */
async function ensureTurnIceServers(): Promise<api.TurnIceServer[]> {
  if (turnIceCache && turnIceCache.expiry > Date.now() + 5 * 60_000) return turnIceCache.iceServers;
  const { token } = useAuth.getState();
  if (!token) return turnIceCache?.iceServers ?? [];
  try {
    const { iceServers, relayMaxBps } = await api.getTurnCredentials(token);
    turnIceCache = { iceServers, expiry: Date.now() + 55 * 60_000 };
    // 中继码率预算随凭据一起下发（服务器按自身出口带宽决定）
    screenShareManager?.setRelayMaxBps(relayMaxBps);
    return iceServers;
  } catch {
    return turnIceCache?.iceServers ?? [];
  }
}


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
    // 发送超时自愈：消息发出 5s 仍未确认且连接显示 open → 连接疑似半开（TCP 假活），强制重连。
    // 仍在排队（订阅未就绪）的消息不算「已发出」——否则重连刚开就误判，把排队消息整批清掉
    const stillQueued = new Set(queuedSends.map((q) => q.tempId).filter((id): id is string => !!id));
    if (
      status === 'open' &&
      pendingSends.some((p) => !stillQueued.has(p.tempId) && Date.now() - p.at > 5000)
    ) {
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
  // 该房间的在途发送与排队一并清理：残留会让看门狗误判半开连接强制重连，
  // 重新加入同一房间时还会把几分钟前的排队消息突然发出去
  for (let i = pendingSends.length - 1; i >= 0; i--) {
    if (pendingSends[i].roomId === roomId) pendingSends.splice(i, 1);
  }
  queuedSends = queuedSends.filter((q) => q.roomId !== roomId);
  useChat.setState((s) => {
    const rooms = s.rooms.filter((r) => r.id !== roomId);
    const messagesByRoom = { ...s.messagesByRoom };
    const membersByRoom = { ...s.membersByRoom };
    const unreadByRoom = { ...s.unreadByRoom };
    const mentionByRoom = { ...s.mentionByRoom };
    const previewByRoom = { ...s.previewByRoom };
    // 历史标记必须一起清：留着会让「退出后重新加入同一房间」跳过历史加载，聊天区永远空白
    const historyLoadedRooms = { ...s.historyLoadedRooms };
    const hasMoreByRoom = { ...s.hasMoreByRoom };
    const loadingOlderRooms = { ...s.loadingOlderRooms };
    delete messagesByRoom[roomId];
    delete membersByRoom[roomId];
    delete unreadByRoom[roomId];
    delete mentionByRoom[roomId];
    delete previewByRoom[roomId];
    delete historyLoadedRooms[roomId];
    delete hasMoreByRoom[roomId];
    delete loadingOlderRooms[roomId];
    const wasActive = s.activeRoomId === roomId;
    return {
      rooms,
      messagesByRoom,
      membersByRoom,
      unreadByRoom,
      mentionByRoom,
      previewByRoom,
      historyLoadedRooms,
      hasMoreByRoom,
      loadingOlderRooms,
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

/** 真正发出后重置计时：排队期间不算「发出未确认」，否则重连一开 socket 就被看门狗误判半开 */
function touchPending(tempId: string): void {
  const p = pendingSends.find((x) => x.tempId === tempId);
  if (p) p.at = Date.now();
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
let queuedSends: { roomId: string; text: string; opts?: SendOptions; tempId?: string }[] = [];

/** 侧栏预览文本：图片无文字显示[图片]、表情显示[表情]、已撤回显示撤回提示 */
function previewTextOf(m: { kind?: 'text' | 'image' | 'sticker'; text: string; recalled?: boolean }): string {
  if (m.recalled) return '撤回了一条消息';
  if (m.kind === 'sticker' && !m.text) return '[表情]';
  return m.kind === 'image' && !m.text ? '[图片]' : m.text;
}

/** 乐观上屏：把用户刚发的消息立即显示（pending 标记），服务器确认后校正 */
function appendOptimistic(roomId: string, text: string, opts?: SendOptions): string | null {
  const me = useChat.getState().me;
  if (!me) return null;
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
          kind: opts?.sticker ? 'sticker' : opts?.mediaUrl || opts?.mediaUrls?.length ? 'image' : 'text',
          mediaUrl: opts?.mediaUrl ?? opts?.mediaUrls?.[0] ?? null,
          mediaUrls: opts?.mediaUrls,
          reply: opts?.reply,
          pending: true,
        },
      ],
    },
  }));
  return tempId;
}

/** 真正发送（不负责乐观上屏，由调用方决定）；tempId 用于把看门狗计时重置到「确实发出」的时刻 */
function doSend(roomId: string, text: string, opts?: SendOptions, tempId?: string): void {
  const ok = socket?.send({ type: 'message:send', payload: { roomId, text, mentions: opts?.mentions, mediaUrl: opts?.mediaUrl, mediaUrls: opts?.mediaUrls, replyTo: opts?.replyTo, kind: opts?.sticker ? 'sticker' : undefined } });
  if (ok) {
    if (tempId) touchPending(tempId);
    playSendSound(useSettings.getState().soundEnabled);
  }
}

/** DM 乐观上屏：结构与房间乐观消息一致（userId=自己），服务器确认后按 tempId 校正 */
function appendPendingDm(peerId: string, text: string, opts?: SendOptions): void {
  const me = useChat.getState().me;
  if (!me) return;
  const tempId = `tmp-${Date.now()}-${++pendingSeq}`;
  appendPending(dmKey(peerId), tempId);
  useChat.setState((s) => ({
    dmMessages: {
      ...s.dmMessages,
      [peerId]: [
        ...(s.dmMessages[peerId] ?? []),
        {
          id: tempId,
          roomId: '',
          userId: me.id,
          username: me.username,
          avatarUrl: me.avatarUrl ?? null,
          text,
          createdAt: new Date().toISOString(),
          kind: opts?.sticker ? 'sticker' : opts?.mediaUrl || opts?.mediaUrls?.length ? 'image' : 'text',
          mediaUrl: opts?.mediaUrl ?? opts?.mediaUrls?.[0] ?? null,
          mediaUrls: opts?.mediaUrls,
          reply: opts?.reply,
          pending: true,
        },
      ],
    },
  }));
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
  mainWindowFocused: true,
  dmMessages: {},
  dmHistoryLoaded: {},
  dmHasMore: {},
  dmUnread: {},
  dmPreviews: {},
  activeDmPeerId: null,
  pendingNotifyTarget: null,
  screenShare: { roomId: null, selfSharing: false, selfSharingAudio: false, shares: {} },

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
          // DM 乐观占位同步清理（否则失败/超时的私聊消息永久挂在界面上）
          dmMessages: Object.fromEntries(
            Object.entries(s.dmMessages).map(([pid, msgs]) => [pid, msgs.filter((m) => !m.pending)]),
          ),
          // 重置历史标记：重连后 selectRoom/openDm 会重新拉取历史，
          // 把断开期间已入库的消息补回来（否则本地会永久丢消息）
          historyLoadedRooms: {},
          dmHistoryLoaded: {},
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
        case 'hello:ok': {
          // 换账号守卫：同一连接生命周期内身份变化（登出后注册/登录新号）→
          // 先清空上一账号的房间/消息/选中态，防止刷新列表时仍按旧 activeRoomId 拉历史（403「你不在该房间中」）
          const prev = get().me;
          if (prev && prev.id !== msg.payload.me.id) {
            get().resetAccountState();
            // resetAccountState 会关 socket，这里需要按现有 token 重建连接
            socket?.close();
            socket = null;
            set({ status: 'idle' });
            get().connect();
            return;
          }
          set({ me: msg.payload.me });
          // 好友列表/申请与房间并行加载
          void useFriends.getState().load();
          // 登录后加载房间列表，并订阅全部房间（refreshRooms 失败也要重订阅）
          void get()
            .refreshRooms()
            .then(() => void Promise.all([get().loadRoomPreviews(), get().loadDmConversations()]))
            .catch(() => undefined)
            .then(() => {
              subscribeAllRooms();
              // DM 优先：开着私聊时不得重载房间历史——selectRoom 会同步清掉 activeDmPeerId，
              // 把用户从私聊里踢回房间（且 DM 历史也因此不会被重拉）
              const dmActive = get().activeDmPeerId;
              if (dmActive) {
                void loadDmHistory(dmActive);
              } else {
                const active = get().activeRoomId;
                if (active) {
                  // 重连后强制重载活跃房间历史（reconnecting 时已重置标记），
                  // 把断开期间已入库的消息补回来，避免本地永久丢消息
                  void get().selectRoom(active, true);
                }
              }
            });
          break;
        }
        case 'room:joined': {
          const roomId = msg.payload.roomId;
          const snapshot = msg.payload.screenShares;
          set((s) => {
            if (roomId !== s.activeRoomId || snapshot === undefined) {
              return {
                subscribedRoomIds: s.subscribedRoomIds.includes(roomId) ? s.subscribedRoomIds : [...s.subscribedRoomIds, roomId],
                membersByRoom: { ...s.membersByRoom, [roomId]: msg.payload.members },
              };
            }
            const byId = new Map(snapshot.map((share) => [share.userId, share]));
            const current = s.screenShare.shares;
            const shares = Object.fromEntries(
              snapshot
                .filter((share) => share.userId !== s.me?.id)
                .map((share) => [
                  share.userId,
                  current[share.userId] ?? { name: share.username, watching: false, remoteStream: null },
                ]),
            );
            for (const [userId, share] of Object.entries(current)) {
              if (!byId.has(userId) && share.watching) screenShareManager?.stopWatching(userId);
            }
            const self = snapshot.some((share) => share.userId === s.me?.id);
            return {
              subscribedRoomIds: s.subscribedRoomIds.includes(roomId) ? s.subscribedRoomIds : [...s.subscribedRoomIds, roomId],
              membersByRoom: { ...s.membersByRoom, [roomId]: msg.payload.members },
              screenShare: { roomId, selfSharing: self, selfSharingAudio: self ? s.screenShare.selfSharingAudio : false, shares },
            };
          });
          // 订阅就绪：把排队的该房间消息按序发出（自动选房/订阅未就绪时排队的）
          {
            const ready = queuedSends.filter((q) => q.roomId === msg.payload.roomId);
            if (ready.length > 0) {
              queuedSends = queuedSends.filter((q) => q.roomId !== msg.payload.roomId);
              for (const q of ready) doSend(q.roomId, q.text, q.opts, q.tempId);
            }
          }
          break;
        }
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
          // 「正在看」= 该房间是活跃会话且没开着私聊（DM 优先，见 isViewingRoom）
          const viewing = isViewingRoom(msg.payload.roomId);
          // @我：非自己消息且提及含我 → 非活跃房间累计 @未读
          const mentionedMe = !isMine && (msg.payload.message.mentions ?? []).some((m) => m.id === state.me?.id);
          if (mentionedMe && !viewing) {
            set((s) => ({
              mentionByRoom: {
                ...s.mentionByRoom,
                [msg.payload.roomId]: (s.mentionByRoom[msg.payload.roomId] ?? 0) + 1,
              },
            }));
          }
          if (!isMine) {
            // 非活跃房间累加未读数；提示音只对别人的消息生效
            if (!viewing) {
              set((s) => ({
                unreadByRoom: {
                  ...s.unreadByRoom,
                  [msg.payload.roomId]: (s.unreadByRoom[msg.payload.roomId] ?? 0) + 1,
                },
              }));
            }
            // @我 用更亮的提示音，和普通消息区分开
            if (mentionedMe) playMentionSound(useSettings.getState().soundEnabled);
            else playMessageSound(useSettings.getState().soundEnabled);
            // Windows 系统通知：按设置档位（仅@我 / 全部；当前正打开的房间不弹，消息就在眼前）
            const level = useSettings.getState().notifyLevel;
            if (!viewing && (level === 'all' || (level === 'mention' && mentionedMe))) {
              const roomName = get().rooms.find((r) => r.id === msg.payload.roomId)?.name ?? '房间';
              void sendWindowsNotify(`#${roomName} · ${msg.payload.message.username}`, previewTextOf(msg.payload.message), {
                kind: 'room',
                id: msg.payload.roomId,
              });
            }
          }
          // 侧栏预览实时更新（多房间订阅使非活跃房间也能即时刷新）；图片/撤回显示对应占位
          set((s) => ({
            previewByRoom: {
              ...s.previewByRoom,
              [msg.payload.roomId]: {
                id: msg.payload.message.id,
                username: msg.payload.message.username,
                userId: msg.payload.message.userId,
                text: previewTextOf(msg.payload.message),
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
            // operator = 实际执行撤回的人（房主代撤时 ≠ 消息作者；旧服务端无此字段回落作者）
            const operator =
              msg.payload.operatorId && msg.payload.operatorUsername
                ? { id: msg.payload.operatorId, username: msg.payload.operatorUsername }
                : undefined;
            const list = s.messagesByRoom[msg.payload.roomId];
            const messages = list
              ? {
                  messagesByRoom: {
                    ...s.messagesByRoom,
                    [msg.payload.roomId]: list.map((m) =>
                      m.id === msg.payload.messageId
                        ? { ...m, recalled: true, text: '', mediaUrl: null, mentions: [], recalledBy: operator ?? m.recalledBy }
                        : m,
                    ),
                  },
                }
              : {};
            const preview = s.previewByRoom[msg.payload.roomId];
            // 被撤回的正是侧栏预览那条 → 预览作者换成操作者；代撤时文案带出被撤人（渲染层拼「操作者 + 撤回了 作者 的消息」）
            const previewPatch =
              preview?.id === msg.payload.messageId
                ? {
                    previewByRoom: {
                      ...s.previewByRoom,
                      [msg.payload.roomId]: {
                        ...preview,
                        userId: operator?.id ?? preview.userId,
                        username: operator?.username ?? preview.username,
                        text:
                          operator && operator.id !== preview.userId
                            ? `撤回了 ${preview.username} 的消息`
                            : '撤回了一条消息',
                      },
                    },
                  }
                : {};
            return { ...messages, ...previewPatch };
          });
          void pushOverlayRecall(msg.payload.messageId);
          break;
        case 'message:edited':
          set((s) => {
            const list = s.messagesByRoom[msg.payload.roomId];
            if (!list) return s;
            const preview = s.previewByRoom[msg.payload.roomId];
            // 预览正是被编辑的那条 → 同步编辑后的文本
            const previewPatch =
              preview?.id === msg.payload.messageId
                ? { previewByRoom: { ...s.previewByRoom, [msg.payload.roomId]: { ...preview, text: msg.payload.text } } }
                : {};
            return {
              messagesByRoom: {
                ...s.messagesByRoom,
                [msg.payload.roomId]: list.map((m) =>
                  m.id === msg.payload.messageId
                    ? {
                        ...m,
                        text: msg.payload.text,
                        editedAt: msg.payload.editedAt,
                        // 服务端会随编辑重算提及：不同步会让编辑时新增/删除的 @ 高亮与角标失真
                        mentions: msg.payload.mentions ?? m.mentions,
                      }
                    : m,
                ),
              },
              ...previewPatch,
            };
          });
          void pushOverlayEdit(msg.payload.messageId, msg.payload.text);
          break;
        case 'dm:new': {
          // 私聊新消息：自己的先校正乐观占位，双方消息统一按会话（对方 id）归档
          const dm = msg.payload.message;
          const mine = state.me;
          if (!mine) break;
          const peerId = dm.from === mine.id ? dm.to : dm.from;
          const isMine = dm.from === mine.id;
          set((s) => {
            const list = s.dmMessages[peerId] ?? [];
            let nextList = list;
            if (isMine) {
              const tempId = shiftPending(dmKey(peerId));
              if (tempId) nextList = list.filter((m) => m.id !== tempId);
            }
            if (nextList.some((m) => m.id === dm.id)) return s;
            return { dmMessages: { ...s.dmMessages, [peerId]: [...nextList, dmToRoomMessage(dm)] } };
          });
          if (!isMine) {
            // 非活跃会话累加未读；提示音只对别人的消息生效
            if (!isViewingDm(peerId)) {
              set((s) => ({ dmUnread: { ...s.dmUnread, [peerId]: (s.dmUnread[peerId] ?? 0) + 1 } }));
            }
            playMessageSound(useSettings.getState().soundEnabled);
            // Windows 系统通知：私聊 = 点对点定向，「仅@」档同样弹出（正打开的会话不弹）
            const level = useSettings.getState().notifyLevel;
            if (!isViewingDm(peerId) && level !== 'none') {
              void sendWindowsNotify(`${dm.username} · 私聊`, previewTextOf(dm), { kind: 'dm', id: peerId });
            }
          }
          // 侧栏私聊预览实时更新
          set((s) => ({
            dmPreviews: {
              ...s.dmPreviews,
              [peerId]: {
                id: dm.id,
                userId: dm.from,
                username: dm.username,
                text: previewTextOf(dm),
                createdAt: dm.createdAt,
              },
            },
          }));
          // Overlay：私聊不标注来源（对方消息的用户名 = 来源好友，标了会重复显示两次名字）
          void pushOverlayMessage(dmToRoomMessage(dm), undefined, isMine);
          break;
        }
        case 'dm:recalled': {
          const peerId = state.me && msg.payload.from === state.me.id ? msg.payload.to : msg.payload.from;
          set((s) => {
            const list = s.dmMessages[peerId];
            const messages = list
              ? {
                  dmMessages: {
                    ...s.dmMessages,
                    [peerId]: list.map((m) =>
                      m.id === msg.payload.messageId ? { ...m, recalled: true, text: '', mediaUrl: null } : m,
                    ),
                  },
                }
              : {};
            const preview = s.dmPreviews[peerId];
            const previewPatch =
              preview?.id === msg.payload.messageId
                ? { dmPreviews: { ...s.dmPreviews, [peerId]: { ...preview, text: '撤回了一条消息' } } }
                : {};
            return { ...messages, ...previewPatch };
          });
          void pushOverlayRecall(msg.payload.messageId);
          break;
        }
        case 'dm:edited': {
          const peerId = state.me && msg.payload.from === state.me.id ? msg.payload.to : msg.payload.from;
          set((s) => {
            const list = s.dmMessages[peerId];
            if (!list) return s;
            const preview = s.dmPreviews[peerId];
            const previewPatch =
              preview?.id === msg.payload.messageId
                ? { dmPreviews: { ...s.dmPreviews, [peerId]: { ...preview, text: msg.payload.text } } }
                : {};
            return {
              dmMessages: {
                ...s.dmMessages,
                [peerId]: list.map((m) =>
                  m.id === msg.payload.messageId ? { ...m, text: msg.payload.text, editedAt: msg.payload.editedAt } : m,
                ),
              },
              ...previewPatch,
            };
          });
          void pushOverlayEdit(msg.payload.messageId, msg.payload.text);
          break;
        }
        case 'screen:started': {
          const { roomId, userId, username } = msg.payload;
          if (roomId !== get().activeRoomId) break;
          if (userId === state.me?.id) {
            // 自己发起共享的回声：标记 selfSharing（不加入 shares）
            set((s) => ({ screenShare: { ...s.screenShare, roomId, selfSharing: true } }));
          } else {
            set((s) => ({
              screenShare: {
                roomId: s.screenShare.roomId ?? roomId,
                selfSharing: s.screenShare.selfSharing,
                selfSharingAudio: s.screenShare.selfSharingAudio,
                shares: { ...s.screenShare.shares, [userId]: { name: username ?? '某人', watching: false, remoteStream: null } },
              },
            }));
          }
          break;
        }
        case 'screen:stopped': {
          if (msg.payload.roomId !== get().activeRoomId && msg.payload.roomId !== get().screenShare.roomId) break;
          const userId = msg.payload.userId as string | undefined;
          const cur = get().screenShare;
          if (!userId || userId === state.me?.id) {
            // 无 userId（旧服务端）或自己停止：整体清理
            set((s) => ({ screenShare: { ...s.screenShare, selfSharing: false } }));
            if (!userId) set({ screenShare: { roomId: null, selfSharing: false, selfSharingAudio: false, shares: {} } });
          } else {
            screenShareManager?.stopWatching(userId);
            const next = { ...cur.shares };
            delete next[userId];
            const empty = Object.keys(next).length === 0;
            set({ screenShare: { roomId: empty && !cur.selfSharing ? null : cur.roomId, selfSharing: cur.selfSharing, selfSharingAudio: cur.selfSharingAudio, shares: next } });
          }
          break;
        }
        case 'screen:signal': {
          void get().handleScreenSignal(msg.payload.from, (msg.payload.roomId as string) ?? get().screenShare.roomId ?? '', msg.payload.data);
          break;
        }
        case 'friend:request':
        case 'friend:accepted':
        case 'friend:declined':
        case 'friend:removed':
        case 'presence:friend':
          // 好友域事件由 friends store 处理（chat socket 是唯一的 WS 通道）
          useFriends.getState().handleWs(msg);
          break;
        case 'error': {
          // 服务器返回错误：清掉未确认的乐观占位与排队消息，避免"幽灵消息"卡在界面上。
          // 定向清理：房间错误只清该房间、私聊错误只清该会话（payload.to），避免殃及无关会话的在途消息
          const errRoomId: string | undefined = msg.payload.roomId;
          if (errRoomId) {
            const list = get().messagesByRoom[errRoomId];
            if (list?.some((m) => m.pending)) {
              shiftPending(errRoomId);
              set((s) => ({
                messagesByRoom: {
                  ...s.messagesByRoom,
                  [errRoomId]: (s.messagesByRoom[errRoomId] ?? []).filter((m) => !m.pending),
                },
              }));
            }
            queuedSends = queuedSends.filter((q) => q.roomId !== errRoomId);
          } else if (state.me && msg.payload.to) {
            // 服务端 dm:send 失败时 payload 带 to/from（会话双方），定位到对应会话清理
            const meId: string = state.me.id;
            const dmPeer = msg.payload.to === meId ? (msg.payload.from ?? '') : msg.payload.to;
            if (!dmPeer) break;
            shiftPending(dmKey(dmPeer));
            set((s) => ({
              dmMessages: {
                ...s.dmMessages,
                [dmPeer]: (s.dmMessages[dmPeer] ?? []).filter((m) => !m.pending),
              },
            }));
          } else {
            // 服务端未带定位信息（rate_limited / empty_message / bad_json 等）：
            // 只回滚最近一条在途消息，不再清空所有会话的乐观气泡与排队消息（曾导致无关会话的消息凭空消失）
            const last = pendingSends[pendingSends.length - 1];
            if (last) {
              pendingSends.pop();
              queuedSends = queuedSends.filter((q) => q.tempId !== last.tempId);
              const isDm = last.roomId.startsWith('dm:');
              const key = isDm ? last.roomId.slice(3) : last.roomId;
              set((s) =>
                isDm
                  ? { dmMessages: { ...s.dmMessages, [key]: (s.dmMessages[key] ?? []).filter((m) => m.id !== last.tempId) } }
                  : { messagesByRoom: { ...s.messagesByRoom, [key]: (s.messagesByRoom[key] ?? []).filter((m) => m.id !== last.tempId) } },
              );
            }
          }
          // 未细分的错误码也给出可见反馈（服务端 message 为人类可读文案）
          if (!['unauthorized', 'not_in_room', 'target_not_in_room', 'only_owner', 'rate_limited', 'muted', 'room_not_found'].includes(msg.payload.code)) {
            set({ roomError: msg.payload.message || `发送失败（${msg.payload.code}）` });
          }
          if (msg.payload.code === 'unauthorized') {
            useAuth.getState().logout();
          } else if (msg.payload.code === 'target_not_in_room') {
            // 目标是别人（踢人/禁言/信令对端）已不在房间——自己仍在房里，绝不能移除自己的房间
            set({ roomError: '对方已不在该房间' });
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
        }
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

  resetAccountState: () => {
    stopSubWatchdog();
    // 换账号：世代自增，让在途的旧账号请求的响应被丢弃（否则会把上个账号的房间/消息写进新会话）
    accountGen += 1;
    // 关闭连接：登出后迟到的 WS 事件（message:new 等）会以 me === null 撞进各 handler，
    // 重建已清空的房间/未读状态、误发通知——断开是一劳永逸的闸门
    socket?.close();
    socket = null;
    screenShareManager?.stopAll();
    screenShareManager = null;
    clearPending();
    queuedSends = [];
    // 快捷键/表情等个性化随账号走：换账号时快捷键还原默认（表情按用户读取在 App 层处理）
    useSettings.getState().setHotkey(DEFAULT_HOTKEY);
    set({
      status: 'closed',
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
      dmMessages: {},
      dmHistoryLoaded: {},
      dmHasMore: {},
      dmUnread: {},
      dmPreviews: {},
      activeDmPeerId: null,
      pendingNotifyTarget: null,
      screenShare: { roomId: null, selfSharing: false, selfSharingAudio: false, shares: {} },
      roomError: null,
      connectionError: null,
    });
    useFriends.getState().reset();
  },

  refreshRooms: async () => {
    const { token } = useAuth.getState();
    if (!token) return;
    const gen = accountGen;
    set({ loadingRooms: true });
    try {
      const { rooms } = await api.listRooms(token);
      if (gen !== accountGen) return; // 请求期间换了账号：丢弃旧账号的房间列表
      // 离线期间被删除的房间：清掉失效的选中态，让自动选择逻辑接管
      const stale = get().activeRoomId && !rooms.some((r) => r.id === get().activeRoomId);
      set({ rooms, ...(stale ? { activeRoomId: null } : {}) });
      // 默认选中第一个房间（正开着私聊时不要抢焦点——否则重连会把用户从私聊里拽出来）
      if (!get().activeRoomId && !get().activeDmPeerId && rooms.length > 0) {
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
    const gen = accountGen;
    // 选中即清零未读（普通 + @我）；room:join 幂等（已订阅时服务端也会回执），看门狗兜底；
    // 切到房间 = 离开 DM 会话（两者互斥表达「活跃会话」）
    set((s) => ({
      activeRoomId: roomId,
      activeDmPeerId: null,
      unreadByRoom: { ...s.unreadByRoom, [roomId]: 0 },
      mentionByRoom: { ...s.mentionByRoom, [roomId]: 0 },
    }));
    subscribeRoom(roomId);
    // 加载历史（首次或 forceReload——重连后强制重拉，补齐断开期间的消息）。
    // 不能用「列表非空」短路：游戏输入框的定向发送会先注入乐观消息，导致历史永远不加载
    if (forceReload || !get().historyLoadedRooms[roomId]) {
      try {
        const since = new Date().toISOString();
        const { messages, hasMore } = await api.roomMessages(token, roomId, { limit: 50 });
        if (gen !== accountGen) return; // 换账号后迟到的历史：丢弃
        set((s) => ({
          // 合并而非覆盖：拉取期间经 WS 到达的新消息不能被旧快照吞掉
          messagesByRoom: { ...s.messagesByRoom, [roomId]: mergeFetchedHistory(messages, s.messagesByRoom[roomId], since) },
          historyLoadedRooms: { ...s.historyLoadedRooms, [roomId]: true },
          hasMoreByRoom: { ...s.hasMoreByRoom, [roomId]: hasMore },
        }));
      } catch (e) {
        // 失败不标记「已加载」：否则整个会话期内该房间永远空白，再点也没有重试机会
        set({ roomError: e instanceof Error ? e.message : '加载历史失败' });
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
    const gen = accountGen;
    const rooms = get().rooms;
    await Promise.all(
      rooms.map(async (r) => {
        try {
          const { messages } = await api.roomMessages(token, r.id, { limit: 1 });
          if (gen !== accountGen) return; // 换账号后迟到的预览：丢弃
          const last = messages[messages.length - 1];
          if (!last) return;
          set((s) => {
            // REST 补齐不覆盖更新的实时预览（message:new 可能先到）
            const existing = s.previewByRoom[r.id];
            if (existing && existing.createdAt > last.createdAt) return s;
            return {
            previewByRoom: {
              ...s.previewByRoom,
              [r.id]: {
                id: last.id,
                // 撤回消息的预览作者 = 撤回操作者（房主代撤），而非消息作者；代撤文案带出被撤人
                username: last.recalledBy?.username ?? last.username,
                userId: last.recalledBy?.id ?? last.userId,
                text:
                  last.recalled && last.recalledBy && last.recalledBy.id !== last.userId
                    ? `撤回了 ${last.username} 的消息`
                    : previewTextOf(last),
                createdAt: last.createdAt,
              },
            },
            };
          });
        } catch {
          // 单个房间失败不影响其他
        }
      }),
    );
  },

  leaveRoom: async (roomId) => {
    const { token } = useAuth.getState();
    if (!token || !roomId) return;
    try {
      await api.leaveRoom(token, roomId);
      // removeRoomLocal 内含退订 WS + 本地清理 + 自动切换到下一个房间
      removeRoomLocal(roomId);
      if (get().activeRoomId) await get().selectRoom(get().activeRoomId!);
    } catch (e) {
      set({ roomError: e instanceof Error ? e.message : '离开房间失败' });
    }
  },

  leaveActiveRoom: async () => {
    const { activeRoomId } = get();
    if (!activeRoomId) return;
    await get().leaveRoom(activeRoomId);
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

  sendMessage: (text, opts, roomOverride) => {
    const trimmed = text.trim();
    // 有图无字也是合法消息：只检查 mediaUrl 会静默丢弃「只发图不打字」
    if (!trimmed && !opts?.mediaUrl && !opts?.mediaUrls?.length) return;
    const { activeRoomId, subscribedRoomIds, status, rooms } = get();
    // 显式目标（快捷输入框独立目标）：直接发送，不扰动主窗口的选中会话
    if (roomOverride) {
      if (status !== 'open' || !subscribedRoomIds.includes(roomOverride)) {
        const tempId = appendOptimistic(roomOverride, trimmed, opts);
        queuedSends.push({ roomId: roomOverride, text: trimmed, opts, tempId: tempId ?? undefined });
        return;
      }
      const tempId = appendOptimistic(roomOverride, trimmed, opts);
      doSend(roomOverride, trimmed, opts, tempId ?? undefined);
      return;
    }
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
      const tempId = appendOptimistic(target, trimmed, opts);
      queuedSends.push({ roomId: target, text: trimmed, opts, tempId: tempId ?? undefined });
      set({ roomError: null });
      return;
    }

    const tempId = appendOptimistic(target, trimmed, opts);
    doSend(target, trimmed, opts, tempId ?? undefined);
  },

  clearRoomError: () => set({ roomError: null }),

  setMainWindowFocused: (focused) => {
    if (get().mainWindowFocused !== focused) set({ mainWindowFocused: focused });
  },

  consumePendingNotifyTarget: () => {
    const target = get().pendingNotifyTarget;
    if (!target) return;
    set({ pendingNotifyTarget: null });
    if (target.kind === 'dm') void get().openDm(target.id);
    else void get().selectRoom(target.id);
  },

  clearActiveDmIf: (peerId) => {
    if (get().activeDmPeerId !== peerId) return;
    set((s) => {
      const dmUnread = { ...s.dmUnread };
      delete dmUnread[peerId];
      return { activeDmPeerId: null, dmUnread };
    });
  },

  openDm: async (peerId) => {
    // 打开会话即清零未读；历史只在首次打开时拉取（重连重载由 hello:ok 强制触发）
    set((s) => ({ activeDmPeerId: peerId, dmUnread: { ...s.dmUnread, [peerId]: 0 } }));
    if (!get().dmHistoryLoaded[peerId]) await loadDmHistory(peerId);
  },

  // 一次性拉取所有私聊会话的最后一条消息（进入应用时补齐侧栏预览，之后由 dm:new 实时更新）
  loadDmConversations: async () => {
    const { token } = useAuth.getState();
    if (!token) return;
    const gen = accountGen;
    try {
      const { conversations } = await api.listDmConversations(token);
      if (gen !== accountGen) return; // 换账号后迟到的会话列表：丢弃
      useChat.setState((s) => {
        const previews = { ...s.dmPreviews };
        for (const c of conversations) {
          previews[c.peerId] = {
            id: c.last.id,
            userId: c.last.from,
            username: c.last.username,
            text: previewTextOf(c.last),
            createdAt: c.last.createdAt,
          };
        }
        return { dmPreviews: previews };
      });
    } catch {
      // 预览加载失败不打断主流程（列表为空即可，服务端过旧时同样降级）
    }
  },

  loadOlderDmMessages: async (peerId) => {
    const { token } = useAuth.getState();
    if (!token) return;
    const key = dmKey(peerId);
    if (!get().dmHasMore[peerId] || get().loadingOlderRooms[key]) return;
    const oldest = (get().dmMessages[peerId] ?? []).find((m) => !m.pending);
    if (!oldest) return;
    set((s) => ({ loadingOlderRooms: { ...s.loadingOlderRooms, [key]: true } }));
    try {
      const { messages, hasMore } = await api.dmMessages(token, peerId, { before: oldest.id, limit: 50 });
      set((s) => {
        const existing = new Set((s.dmMessages[peerId] ?? []).map((m) => m.id));
        const fresh = messages.map(dmToRoomMessage).filter((m) => !existing.has(m.id));
        return {
          dmMessages: { ...s.dmMessages, [peerId]: [...fresh, ...(s.dmMessages[peerId] ?? [])] },
          dmHasMore: { ...s.dmHasMore, [peerId]: hasMore },
          dmHistoryLoaded: { ...s.dmHistoryLoaded, [peerId]: true },
        };
      });
    } catch (e) {
      set({ roomError: e instanceof Error ? e.message : '加载更早消息失败' });
    } finally {
      set((s) => ({ loadingOlderRooms: { ...s.loadingOlderRooms, [key]: false } }));
    }
  },

  sendDm: (text, opts, peerOverride) => {
    const trimmed = text.trim();
    // 同上：纯图片私聊不能被空文本守卫吞掉
    if (!trimmed && !opts?.mediaUrl && !opts?.mediaUrls?.length) return;
    // 显式目标（快捷输入框独立目标）优先于主窗口正在查看的会话
    const peerId = peerOverride ?? get().activeDmPeerId;
    if (!peerId) return;
    if (get().status !== 'open' || !socket) {
      set({ roomError: '连接未就绪，无法发送私聊消息' });
      return;
    }
    const ok = socket.send({ type: 'dm:send', payload: { to: peerId, text: trimmed, mediaUrl: opts?.mediaUrl, mediaUrls: opts?.mediaUrls, replyTo: opts?.replyTo, kind: opts?.sticker ? 'sticker' : undefined } });
    if (ok) {
      playSendSound(useSettings.getState().soundEnabled);
      appendPendingDm(peerId, trimmed, opts);
    }
  },

  recallDm: (messageId) => {
    if (get().status !== 'open' || !socket) {
      set({ roomError: '连接未就绪，无法操作' });
      return;
    }
    // 服务端校验仅发送者可撤，成功后广播 dm:recalled（双端清空内容）
    socket.send({ type: 'dm:recall', payload: { messageId } });
  },

  editMessage: (roomId, messageId, text) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (get().status !== 'open' || !socket) {
      set({ roomError: '连接未就绪，无法操作' });
      return;
    }
    // 服务端校验仅发送者、未撤回、非空，成功后广播 message:edited（各端更新文本与「已编辑」标）
    socket.send({ type: 'message:edit', payload: { roomId, messageId, text: trimmed } });
  },

  editDm: (messageId, text) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (get().status !== 'open' || !socket) {
      set({ roomError: '连接未就绪，无法操作' });
      return;
    }
    socket.send({ type: 'dm:edit', payload: { messageId, text: trimmed } });
  },

  forwardMessage: (source, messageId, target) => {
    if (get().status !== 'open' || !socket) {
      set({ roomError: '连接未就绪，无法操作' });
      return;
    }
    const ok = socket.send({
      type: 'message:forward',
      payload: {
        source,
        messageId,
        ...(target.roomId ? { targetRoomId: target.roomId } : {}),
        ...(target.userId ? { targetUserId: target.userId } : {}),
      },
    });
    if (!ok) set({ roomError: '连接未就绪，无法操作' });
  },

  startScreenShare: async () => {
    const { status, activeRoomId, me } = get();
    if (status !== 'open' || !socket || !activeRoomId || !me) {
      set({ roomError: '连接未就绪或不在房间中' });
      return;
    }
    const sock: ChatSocket = socket;
    const roomId = activeRoomId;
    if (!screenShareManager) screenShareManager = new ScreenShareManager();
    const mgr = screenShareManager;
    // 自建 TURN 凭据（非阻塞预热；sender pc 在观看者请求时才建，届时凭据已就绪）
    void ensureTurnIceServers().then((list) => mgr.setExtraIceServers(list as unknown as RTCIceServer[]));
    mgr.setSignalSender((to, rid, data) => sock.send({ type: 'screen:signal', payload: { roomId: rid, to, data } }));
    mgr.setRemoteStreamHandler((sharerId, stream) => {
      set((s) => {
        const sh = s.screenShare.shares[sharerId];
        return sh ? { screenShare: { ...s.screenShare, shares: { ...s.screenShare.shares, [sharerId]: { ...sh, remoteStream: stream } } } } : {};
      });
    });
    try {
      await mgr.start(roomId, (to, rid, data) => sock.send({ type: 'screen:signal', payload: { roomId: rid, to, data } }), () => {
        // 本地轨道结束（浏览器原生「停止共享」按钮）：通知服务端并清 selfSharing
        sock.send({ type: 'screen:stop', payload: { roomId } });
        set((s) => ({ screenShare: { ...s.screenShare, selfSharing: false, selfSharingAudio: false } }));
      });
    } catch (e) {
      set({ roomError: e instanceof Error ? e.message : '无法开始屏幕共享' });
      return;
    }
    if (!mgr.isSharing) return; // 用户在系统选择器取消：静默
    sock.send({ type: 'screen:start', payload: { roomId } });
    set((s) => ({
      screenShare: {
        roomId: s.screenShare.roomId ?? roomId,
        selfSharing: true,
        selfSharingAudio: mgr.hasAudio,
        shares: s.screenShare.shares,
      },
    }));
  },

  stopScreenShare: () => {
    // 主窗口/独立采集窗两种模式都要广播 screen:stop（采集窗收到后自行停止轨道）
    const { activeRoomId } = get();
    const roomId = get().screenShare.roomId ?? activeRoomId;
    if (roomId && socket) {
      socket.send({ type: 'screen:stop', payload: { roomId } });
    }
    // 内嵌共享路径（浏览器回落）：停本地轨道；onSelfStop 会再发一次 stop，服务端幂等
    screenShareManager?.stopLocal();
    set((s) => ({ screenShare: { ...s.screenShare, selfSharing: false, selfSharingAudio: false } }));
  },

  handleScreenSignal: async (from, roomId, data) => {
    if (!socket) return;
    // 只处理当前共享/观看所在房间的信令：服务端仅校验双方都是该房间成员，
    // 若对端在我共享 A 房时发来 B 房信令，会把 A 房画面误挂到 B 房
    if (roomId !== get().screenShare.roomId) return;
    if (!screenShareManager) screenShareManager = new ScreenShareManager();
    const mgr = screenShareManager;
    // 开发/自动化验证钩子：浏览器回落路径下把 manager 暴露出来，便于 E2E 驱动档位切换
    if (import.meta.env?.DEV) (globalThis as Record<string, unknown>).__gtShareMgr = mgr;
    const sock: ChatSocket = socket;
    mgr.setSignalSender((to, rid, d) => sock.send({ type: 'screen:signal', payload: { roomId: rid, to, data: d } }));
    mgr.setRemoteStreamHandler((sharerId, stream) => {
      set((s) => {
        const sh = s.screenShare.shares[sharerId];
        return sh ? { screenShare: { ...s.screenShare, shares: { ...s.screenShare.shares, [sharerId]: { ...sh, remoteStream: stream } } } } : {};
      });
    });
    mgr.setIceStateHandler((id, state) => {
      set((s) => {
        const sh = s.screenShare.shares[id];
        return sh ? { screenShare: { ...s.screenShare, shares: { ...s.screenShare.shares, [id]: { ...sh, ice: state } } } } : {};
      });
    });
    // 收到 offer/request 而建的 pc 同样需要自建 TURN 凭据（命中缓存时近乎即时）
    mgr.setExtraIceServers((await ensureTurnIceServers()) as unknown as RTCIceServer[]);
    await mgr.handleSignal(from, roomId, data);
  },

  watchScreenShare: async (sharerId) => {
    const { status } = get();
    const roomId = get().screenShare.roomId ?? get().activeRoomId;
    if (!roomId || status !== 'open' || !socket) {
      set({ roomError: '连接未就绪，无法观看共享' });
      return;
    }
    if (!screenShareManager) screenShareManager = new ScreenShareManager();
    const mgr = screenShareManager;
    // 开发/自动化验证钩子：浏览器回落路径下把 manager 暴露出来，便于 E2E 驱动档位切换
    if (import.meta.env?.DEV) (globalThis as Record<string, unknown>).__gtShareMgr = mgr;
    const sock: ChatSocket = socket;
    // receiver pc 的 ICE 配置在构造时固定，必须先拿到自建 TURN 凭据再建连接
    mgr.setExtraIceServers((await ensureTurnIceServers()) as unknown as RTCIceServer[]);
    mgr.setSignalSender((to, rid, d) => sock.send({ type: 'screen:signal', payload: { roomId: rid, to, data: d } }));
    mgr.setRemoteStreamHandler((id, stream) => {
      set((s) => {
        const sh = s.screenShare.shares[id];
        return sh ? { screenShare: { ...s.screenShare, shares: { ...s.screenShare.shares, [id]: { ...sh, remoteStream: stream } } } } : {};
      });
    });
    mgr.setIceStateHandler((id, state) => {
      set((s) => {
        const sh = s.screenShare.shares[id];
        return sh ? { screenShare: { ...s.screenShare, shares: { ...s.screenShare.shares, [id]: { ...sh, ice: state } } } } : {};
      });
    });
    set((s) =>
      s.screenShare.shares[sharerId]
        ? { screenShare: { ...s.screenShare, shares: { ...s.screenShare.shares, [sharerId]: { ...s.screenShare.shares[sharerId], watching: true, remoteStream: null } } } }
        : {},
    );
    mgr.watch(sharerId, roomId);
  },

  stopWatching: (sharerId) => {
    screenShareManager?.stopWatching(sharerId);
    set((s) =>
      s.screenShare.shares[sharerId]
        ? { screenShare: { ...s.screenShare, shares: { ...s.screenShare.shares, [sharerId]: { ...s.screenShare.shares[sharerId], watching: false, remoteStream: null } } } }
        : {},
    );
  },

  markShareExternal: (sharerId, external) => {
    set((s) =>
      s.screenShare.shares[sharerId]
        ? { screenShare: { ...s.screenShare, shares: { ...s.screenShare.shares, [sharerId]: { ...s.screenShare.shares[sharerId], external } } } }
        : {},
    );
  },
}));

/** 拉取指定会话的完整历史（首次打开 / 重连重载共用；合并本地在途消息后落库） */
async function loadDmHistory(peerId: string): Promise<void> {
  const { token } = useAuth.getState();
  if (!token) return;
  const gen = accountGen;
  try {
    const since = new Date().toISOString();
    const { messages, hasMore } = await api.dmMessages(token, peerId, { limit: 50 });
    if (gen !== accountGen) return; // 换账号后迟到的历史：丢弃
    useChat.setState((s) => ({
      // 合并而非覆盖：拉取期间经 WS 到达的新消息不能被旧快照吞掉
      dmMessages: { ...s.dmMessages, [peerId]: mergeFetchedHistory(messages.map(dmToRoomMessage), s.dmMessages[peerId], since) },
      dmHistoryLoaded: { ...s.dmHistoryLoaded, [peerId]: true },
      dmHasMore: { ...s.dmHasMore, [peerId]: hasMore },
    }));
  } catch (e) {
    // 失败不标记「已加载」：否则该私聊本次会话内永远空白且无法重试
    useChat.setState({ roomError: e instanceof Error ? e.message : '加载私聊历史失败' });
  }
}
