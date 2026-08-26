import type { ClientWsMessage, ServerWsMessage, WsStatus } from './types';

export type WsListener = (msg: ServerWsMessage) => void;

/**
 * GameTalk WebSocket 客户端。
 * - 自动重连（指数退避，Phase 6 将完善退避上限与手动重试）
 * - 连接状态通过 onStatus 通知
 * - 心跳 ping（30s）维持连接
 */
export class ChatSocket {
  private ws: WebSocket | null = null;
  private url: string | null = null;
  private listeners = new Set<WsListener>();
  private statusListeners = new Set<(s: WsStatus) => void>();
  private retryCount = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private closedByUser = false;

  get status(): WsStatus {
    return this.ws ? (this.ws.readyState === WebSocket.OPEN ? 'open' : 'connecting') : this.closedByUser ? 'closed' : 'idle';
  }

  onMessage(fn: WsListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onStatus(fn: (s: WsStatus) => void): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  connect(url: string, autoReconnect = true): void {
    this.url = url;
    this.closedByUser = false;
    this.open();
    if (autoReconnect) {
      // 状态通知挂在 connect 的 ws 上，由 open/close 驱动
    }
  }

  private open(): void {
    if (!this.url) return;
    this.emitStatus(this.retryCount > 0 ? 'reconnecting' : 'connecting');
    try {
      this.ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.retryCount = 0;
      this.emitStatus('open');
      this.startHeartbeat();
    };
    this.ws.onmessage = (ev) => {
      let msg: ServerWsMessage;
      try {
        msg = JSON.parse(String(ev.data)) as ServerWsMessage;
      } catch {
        return;
      }
      for (const fn of [...this.listeners]) fn(msg);
    };
    this.ws.onclose = () => {
      this.stopHeartbeat();
      if (this.closedByUser) {
        this.emitStatus('closed');
      } else {
        this.scheduleReconnect();
      }
    };
    this.ws.onerror = () => {
      // onclose 会随后触发并处理重连
    };
  }

  private scheduleReconnect(): void {
    if (this.closedByUser || !this.url) return;
    const delay = Math.min(1000 * 2 ** this.retryCount, 15000);
    this.retryCount += 1;
    this.emitStatus('reconnecting');
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.send({ type: 'ping' });
      }
    }, 30000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  send(msg: ClientWsMessage): boolean {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopHeartbeat();
    this.ws?.close();
    this.ws = null;
    this.emitStatus('closed');
  }

  private emitStatus(s: WsStatus): void {
    for (const fn of [...this.statusListeners]) fn(s);
  }
}
