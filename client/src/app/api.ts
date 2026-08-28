import { useSettings } from './settings';

export interface PublicUser {
  id: string;
  username: string;
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
  const { serverUrl } = useSettings.getState();
  let res: Response;
  try {
    // 请求超时（默认 10s）：防止服务器/网络挂起时 UI 永远卡在"加载中…"
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10000);
    try {
      res = await fetch(`${serverUrl}${path}`, {
        method: options.method ?? 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    // 网络不可达（server 未启动 / 地址错误 / 超时）
    throw new ApiError(
      0,
      'network_error',
      `无法连接服务器（${serverUrl}）。请确认服务器地址正确且服务器已运行；自建服务器请参阅部署文档。`,
    );
  }

  const text = await res.text();
  const data = text ? (JSON.parse(text) as { error?: { code: string; message: string } } & T) : undefined;

  if (!res.ok) {
    const err = data?.error;
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

export function patchMe(token: string, patch: { username?: string; avatarUrl?: string }): Promise<{ user: PublicUser }> {
  return request<{ user: PublicUser }>('/api/auth/me', { method: 'PATCH', token, body: patch });
}

export function uploadAvatar(token: string, dataUrl: string): Promise<{ user: PublicUser }> {
  return request<{ user: PublicUser }>('/api/auth/avatar', { method: 'POST', token, body: { dataUrl } });
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
