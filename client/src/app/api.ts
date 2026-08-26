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

async function request<T>(path: string, options: { method?: string; body?: unknown; token?: string } = {}): Promise<T> {
  const { serverUrl } = useSettings.getState();
  const res = await fetch(`${serverUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

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
