/**
 * 独立窗口（采集窗 / 观看窗）用的信令通道。
 *
 * 主窗口有 ChatSocket + zustand store 那一套；独立窗口只需要「连上 → hello → room:join」，
 * 外加断线自动重连。每次重新加入房间都会回调 onJoined，调用方据此重发 screen:start / request，
 * 这样网络抖动或服务端重启不会再让共享/观看直接结束。
 */
import { deviceId } from './device';

export type SignalStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface SignalMessage {
  type: string;
  payload?: Record<string, unknown>;
}

interface SignalSocketOptions {
  /** ws:// 或 wss:// 地址 */
  url: string;
  token: string;
  roomId: string;
  onMessage: (msg: SignalMessage) => void;
  /** 每次成功加入房间后触发（含重连） */
  onJoined: () => void;
  onStatus?: (status: SignalStatus) => void;
}

/** 重连退避（与主窗口一致，封顶 5s） */
const RETRY_DELAYS = [1000, 1000, 2000, 3000, 5000];
const PING_INTERVAL_MS = 15_000;
const ALIVE_TIMEOUT_MS = 40_000;

export class SignalSocket {
  private ws: WebSocket | null = null;
  private retry = 0;
  private disposed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastAliveAt = 0;

  constructor(private readonly opts: SignalSocketOptions) {}

  connect(): void {
    if (this.disposed) return;
    this.opts.onStatus?.(this.retry > 0 ? 'reconnecting' : 'connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.opts.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.lastAliveAt = Date.now();
    ws.onopen = () => {
      this.retry = 0;
      this.lastAliveAt = Date.now();
      this.send({ type: 'hello', payload: { token: this.opts.token, deviceId: deviceId() } });
    };
    ws.onmessage = (ev) => {
      this.lastAliveAt = Date.now();
      let msg: SignalMessage;
      try {
        msg = JSON.parse(String(ev.data)) as SignalMessage;
      } catch {
        return;
      }
      switch (msg.type) {
        case 'hello:ok':
          this.send({ type: 'room:join', payload: { roomId: this.opts.roomId } });
          break;
        case 'room:joined':
          this.opts.onStatus?.('open');
          this.opts.onJoined();
          break;
        case 'error':
          if ((msg.payload as { code?: string } | undefined)?.code === 'session_replaced') {
            // 账号在别处登录：立刻停掉重连。不停的话两端会互相顶号，形成无限对踢。
            this.close();
          }
          this.opts.onMessage(msg);
          break;
        default:
          this.opts.onMessage(msg);
      }
    };
    ws.onclose = () => {
      if (this.disposed) {
        this.opts.onStatus?.('closed');
        return;
      }
      this.stopHeartbeat();
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      // onclose 会随后触发并负责重连
    };
    this.startHeartbeat();
  }

  send(msg: SignalMessage): void {
    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
    } catch {
      /* 连接已断，等重连 */
    }
  }

  close(): void {
    this.disposed = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.pingTimer = setInterval(() => {
      // 超过存活窗口没收到任何消息：判半开，主动断开触发重连
      if (Date.now() - this.lastAliveAt > ALIVE_TIMEOUT_MS) {
        try {
          this.ws?.close();
        } catch {
          /* ignore */
        }
        return;
      }
      this.send({ type: 'ping' });
    }, PING_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) return;
    const delay = RETRY_DELAYS[Math.min(this.retry, RETRY_DELAYS.length - 1)];
    this.retry += 1;
    this.opts.onStatus?.('reconnecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}

/** 由 REST 地址推导 WS 地址 */
export function wsUrlOfServerUrl(serverUrl: string): string {
  return serverUrl.replace(/^http/, 'ws').replace(/\/+$/, '') + '/ws';
}
