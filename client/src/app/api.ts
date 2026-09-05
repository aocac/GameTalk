import { useSettings } from './settings';

export interface PublicUser {
  id: string;
  username: string;
  avatarUrl: string | null;
  bio: string | null;
  createdAt: string;
}

/** 成员卡片公开资料 */
export interface MemberProfile {
  id: string;
  username: string;
  bio: string | null;
  avatarUrl: string | null;
  createdAt: string;
}

export interface AuthResponse {
  token: string;
  user: PublicUser;
}

export class ApiError extends Error {
  code: string;
  status: number;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function request<T>(
  path: string,
  options: { method?: string; body?: unknown; token?: string; timeoutMs?: number } = {},
): Promise<T> {
  // 防御：历史持久化的地址可能带尾斜杠，拼接前统一去掉，避免 //api/... 双斜杠 404
  const base = useSettings.getState().serverUrl.replace(/\/+$/, '');
  const controller = new AbortController();
  // 请求超时（默认 10s）：覆盖 fetch 与 body 读取全程——只包 fetch 的话，挂起的响应体仍会让 UI 永远转圈
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10000);
  try {
    const res = await fetch(`${base}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        // 仅在有 body 时携带 JSON Content-Type：Fastify 5 对「声明 JSON 但 body 为空」会 400
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
    const text = await res.text();
    let data: ({ error?: { code: string; message: string } } & T) | undefined;
    if (text) {
      try {
        data = JSON.parse(text) as { error?: { code: string; message: string } } & T;
      } catch {
        // 非 JSON 响应（反向代理 502 页面、网关 HTML 错误页等）：不能让 SyntaxError 裸抛
        throw new ApiError(res.status, 'bad_response', `服务器返回异常内容（HTTP ${res.status}），请稍后重试`);
      }
    }

    if (!res.ok) {
      const err = data?.error;
      if (res.status === 429) {
        throw new ApiError(429, 'rate_limited', err?.message ?? '请求过于频繁，请稍后再试');
      }
      throw new ApiError(res.status, err?.code ?? 'unknown', err?.message ?? `HTTP ${res.status}`);
    }
    // 2xx 但空 body：调用方要解构响应字段，undefined 会变成下游 TypeError
    if (data === undefined) {
      throw new ApiError(res.status, 'bad_response', `服务器响应缺少数据（HTTP ${res.status}）`);
    }
    return data;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    // AbortError = 超时（服务器可达但响应太慢）；其余为网络不可达
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new ApiError(0, 'timeout', `服务器响应超时（${base}）`);
    }
    throw new ApiError(
      0,
      'network_error',
      `无法连接服务器（${base}）。请确认服务器地址正确且服务器已运行；自建服务器请参阅部署文档。`,
    );
  } finally {
    clearTimeout(timer);
  }
}

export function register(username: string, password: string): Promise<AuthResponse> {
  return request<AuthResponse>('/api/auth/register', { method: 'POST', body: { username, password } });
}

export function login(username: string, password: string): Promise<AuthResponse> {
  return request<AuthResponse>('/api/auth/login', { method: 'POST', body: { username, password } });
}

export function fetchMe(token: string): Promise<{ user: PublicUser }> {
  return request<{ user: PublicUser }>('/api/auth/me', { token });
}

export function patchMe(token: string, patch: { username?: string; avatarUrl?: string; bio?: string }): Promise<{ user: PublicUser }> {
  return request<{ user: PublicUser }>('/api/auth/me', { method: 'PATCH', token, body: patch });
}

/** 查看成员公开资料（成员卡片） */
export function getUserProfile(token: string, userId: string): Promise<{ user: MemberProfile }> {
  return request<{ user: MemberProfile }>(`/api/users/${userId}`, { token });
}

export function uploadAvatar(token: string, dataUrl: string): Promise<{ user: PublicUser }> {
  return request<{ user: PublicUser }>('/api/auth/avatar', { method: 'POST', token, body: { dataUrl } });
}

/** 上传消息图片（服务端校验类型与 5MB 上限），返回相对 url（/api/media/:id） */
export function uploadImage(token: string, dataUrl: string): Promise<{ id: string; url: string }> {
  return request<{ id: string; url: string }>('/api/media', { method: 'POST', token, body: { dataUrl } });
}

// ============ 房间 ============

export interface Room {
  id: string;
  name: string;
  inviteCode: string;
  ownerId: string;
  memberCount: number;
  createdAt: string;
}

export interface RoomMessage {
  id: string;
  roomId: string;
  userId: string;
  username: string;
  avatarUrl?: string | null;
  text: string;
  createdAt: string;
  /** 提及快照（服务端解析后的 {id, username}） */
  mentions?: Array<{ id: string; username: string }>;
  kind?: 'text' | 'image' | 'sticker';
  mediaUrl?: string | null;
  /** 引用回复的原消息快照 */
  reply?: { id: string; username: string; text: string; kind: 'text' | 'image' | 'sticker' };
  /** 已撤回：内容已清空 */
  recalled?: boolean;
  /** 编辑时间（ISO；仅编辑过的消息携带） */
  editedAt?: string;
  /** 撤回操作者（房主代撤时与作者不同） */
  recalledBy?: { id: string; username: string };
  /** 转发来源快照（纯展示） */
  forwardedFromLabel?: string | null;
  /** 客户端本地字段：乐观发送未确认时标记（服务器返回的消息无此字段） */
  pending?: boolean;
}

export function listRooms(token: string): Promise<{ rooms: Room[] }> {
  return request<{ rooms: Room[] }>('/api/rooms', { token });
}

export function createRoom(token: string, name: string): Promise<{ room: Room }> {
  return request<{ room: Room }>('/api/rooms', { method: 'POST', token, body: { name } });
}

export function joinRoomByCode(token: string, inviteCode: string): Promise<{ room: Room }> {
  return request<{ room: Room }>('/api/rooms/join', { method: 'POST', token, body: { inviteCode } });
}

export function leaveRoom(token: string, roomId: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/rooms/${roomId}/leave`, { method: 'POST', token });
}

export function roomMessages(
  token: string,
  roomId: string,
  opts: { before?: string; limit?: number } = {},
): Promise<{ messages: RoomMessage[]; hasMore: boolean }> {
  const params = new URLSearchParams();
  if (opts.before) params.set('before', opts.before);
  if (opts.limit) params.set('limit', String(opts.limit));
  const qs = params.toString();
  return request<{ messages: RoomMessage[]; hasMore: boolean }>(`/api/rooms/${roomId}/messages${qs ? `?${qs}` : ''}`, {
    token,
  });
}

// ============ 好友 ============

export interface Friend {
  id: string;
  username: string;
  avatarUrl: string | null;
  bio: string | null;
  online: boolean;
}

export interface FriendRequestItem {
  id: string;
  createdAt: string;
  user: { id: string; username: string; avatarUrl: string | null; bio: string | null };
}

export function listFriends(token: string): Promise<{ friends: Friend[] }> {
  return request<{ friends: Friend[] }>('/api/friends', { token });
}

export function sendFriendRequest(
  token: string,
  target: { userId?: string; username?: string },
): Promise<{ request: { id: string; status: string; user: { id: string; username: string } } }> {
  return request<{ request: { id: string; status: string; user: { id: string; username: string } } }>(
    '/api/friends/requests',
    { method: 'POST', token, body: target },
  );
}

export function listFriendRequests(token: string): Promise<{ incoming: FriendRequestItem[]; outgoing: FriendRequestItem[] }> {
  return request<{ incoming: FriendRequestItem[]; outgoing: FriendRequestItem[] }>('/api/friends/requests', { token });
}

export function acceptFriendRequest(token: string, id: string): Promise<{ friend: Friend | null }> {
  return request<{ friend: Friend | null }>(`/api/friends/requests/${id}/accept`, { method: 'POST', token });
}

export function declineFriendRequest(token: string, id: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/friends/requests/${id}/decline`, { method: 'POST', token });
}

export function removeFriend(token: string, userId: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/friends/${userId}/remove`, { method: 'POST', token });
}

// ============ 云表情包（个人 / 群共享） ============

export interface StickerItem {
  id: string;
  mediaId: string;
  url: string;
  addedBy: string;
  addedByUsername: string;
  createdAt: string;
}

export function listStickers(token: string): Promise<{ stickers: StickerItem[]; max: number }> {
  return request<{ stickers: StickerItem[]; max: number }>('/api/stickers', { token });
}

export function addSticker(token: string, mediaId: string): Promise<{ sticker: StickerItem }> {
  return request<{ sticker: StickerItem }>('/api/stickers', { method: 'POST', token, body: { mediaId } });
}

export function deleteSticker(token: string, id: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/stickers/${id}`, { method: 'DELETE', token });
}

export function listRoomStickers(token: string, roomId: string): Promise<{ stickers: StickerItem[]; max: number }> {
  return request<{ stickers: StickerItem[]; max: number }>(`/api/rooms/${roomId}/stickers`, { token });
}

export function addRoomSticker(token: string, roomId: string, mediaId: string): Promise<{ sticker: StickerItem }> {
  return request<{ sticker: StickerItem }>(`/api/rooms/${roomId}/stickers`, { method: 'POST', token, body: { mediaId } });
}

export function deleteRoomSticker(token: string, roomId: string, stickerId: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/rooms/${roomId}/stickers/${stickerId}`, { method: 'DELETE', token });
}

// ============ 好友私聊（DM） ============

/** DM 会话列表项：peerId + 该会话最后一条消息 */
export interface DmConversation {
  peerId: string;
  last: {
    id: string;
    from: string;
    to: string;
    username: string;
    text: string;
    createdAt: string;
    kind?: 'text' | 'image' | 'sticker';
    recalled?: boolean;
  };
}

export function listDmConversations(token: string): Promise<{ conversations: DmConversation[] }> {
  return request<{ conversations: DmConversation[] }>('/api/dm/conversations', { token });
}

/** 服务端 DM 消息形状（from/to 表达方向；store 层转换为渲染消息） */
export interface DmApiMessage {
  id: string;
  from: string;
  to: string;
  username: string;
  avatarUrl?: string | null;
  text: string;
  createdAt: string;
  kind?: 'text' | 'image' | 'sticker';
  mediaUrl?: string | null;
  reply?: { id: string; username: string; text: string; kind: 'text' | 'image' | 'sticker' };
  recalled?: boolean;
  editedAt?: string;
  /** 转发来源快照（纯展示） */
  forwardedFromLabel?: string | null;
}

export function dmMessages(
  token: string,
  peerId: string,
  opts: { before?: string; limit?: number } = {},
): Promise<{ messages: DmApiMessage[]; hasMore: boolean }> {
  const params = new URLSearchParams();
  if (opts.before) params.set('before', opts.before);
  if (opts.limit) params.set('limit', String(opts.limit));
  const qs = params.toString();
  return request<{ messages: DmApiMessage[]; hasMore: boolean }>(`/api/dm/${peerId}/messages${qs ? `?${qs}` : ''}`, {
    token,
  });
}

// ============ 邀请链接 ============

export interface InviteLink {
  id: string;
  code: string;
  roomId: string;
  createdBy: string;
  inviterName?: string;
  /** ISO 或 null（永久） */
  expiresAt: string | null;
  /** 0 = 不限 */
  maxUses: number;
  usedCount: number;
}

export function createInviteLink(
  token: string,
  roomId: string,
  opts: { expiresInHours?: number; maxUses?: number } = {},
): Promise<{ invite: InviteLink }> {
  return request<{ invite: InviteLink }>(`/api/rooms/${roomId}/invites`, { method: 'POST', token, body: opts });
}

export function listInviteLinks(token: string, roomId: string): Promise<{ invites: InviteLink[] }> {
  return request<{ invites: InviteLink[] }>(`/api/rooms/${roomId}/invites`, { token });
}

export function revokeInviteLink(token: string, code: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/invites/${code}`, { method: 'DELETE', token });
}

export function getInvitePreview(
  token: string,
  code: string,
): Promise<{ invite: { code: string; roomName: string; inviterName: string; expiresAt: string | null; maxUses: number; usedCount: number; valid: boolean; alreadyMember: boolean } }> {
  return request<{ invite: { code: string; roomName: string; inviterName: string; expiresAt: string | null; maxUses: number; usedCount: number; valid: boolean; alreadyMember: boolean } }>(
    `/api/invites/${code}`,
    { token },
  );
}

export function redeemInvite(token: string, code: string): Promise<{ room: Room }> {
  return request<{ room: Room }>(`/api/invites/${code}/redeem`, { method: 'POST', token });
}

/** TURN 中继限时凭据（服务端 coturn use-auth-secret；未配置 TURN 时 iceServers 为空） */
export interface TurnIceServer {
  urls: string[];
  username: string;
  credential: string;
}

export function getTurnCredentials(token: string): Promise<{ iceServers: TurnIceServer[] }> {
  return request<{ iceServers: TurnIceServer[] }>('/api/turn', { token });
}
