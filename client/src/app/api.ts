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
  let res: Response;
  try {
    // 请求超时（默认 10s）：防止服务器/网络挂起时 UI 永远卡在"加载中…"
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10000);
    try {
      res = await fetch(`${base}${path}`, {
        method: options.method ?? 'GET',
        headers: {
          // 仅在有 body 时携带 JSON Content-Type：Fastify 5 对「声明 JSON 但 body 为空」会 400
          ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // 网络不可达（server 未启动 / 地址错误 / 超时）
    throw new ApiError(
      0,
      'network_error',
      `无法连接服务器（${base}）。请确认服务器地址正确且服务器已运行；自建服务器请参阅部署文档。`,
    );
  }

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
  return data as T;
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
  kind?: 'text' | 'image';
  mediaUrl?: string | null;
  /** 已撤回：内容已清空 */
  recalled?: boolean;
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
