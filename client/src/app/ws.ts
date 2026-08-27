import type { ClientWsMessage, ServerWsMessage, WsStatus } from './types';

export type WsListener = (msg: ServerWsMessage) => void;

/**
 * GameTalk WebSocket 客户端。
 * - 自动重连（快速退避：1,1,2,3,5s）
 * - 连接状态通过 onStatus 通知
 * - 心跳 ping（15s）维持连接 + pong 超时检测（35s 无 pong = 半开连接，强制重连）
 */
export class ChatSocket {
  private ws: WebSocket | null = null;
  private url: string | null = null;
  private listeners = new Set<WsListener>();
  private statusListeners = new Set<(s: WsStatus) => void>();
  private retryCount = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUser = false;
  private _lastError: string | null = null;
  /** 最近一次收到 pong 的时间（心跳存活检测：半开连接会在此暴露） */
  private lastPongAt = 0;

  get status(): WsStatus {
    return this.ws ? (this.ws.readyState === WebSocket.OPEN ? 'open' : 'connecting') : this.closedByUser ? 'closed' : 'idle';
  }

  /** 最近一次连接失败原因（open 后清空） */
  get lastError(): string | null {
    return this._lastError;
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

  /** 强制重连（半开连接/发送超时检测用）：关闭当前连接但不标记用户主动断开，onclose 走自动重连 */
  forceReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.ws?.close();
  }

  private open(): void {
    if (!this.url) return;
    this.emitStatus(this.retryCount > 0 ? 'reconnecting' : 'connecting');
    try {
      this.ws = new WebSocket(this.url);
    } catch {
      this._lastError = '无法创建 WebSocket 连接';
      this.scheduleReconnect();
      return;
    }

    // 连接超时：8 秒未握手成功视为失败，关闭并触发重连
    this.connectTimer = setTimeout(() => {
      if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
        this._lastError = '连接超时';
        this.ws.close();
      }
    }, 8000);

    this.ws.onopen = () => {
      this.retryCount = 0;
      this._lastError = null;
      this.lastPongAt = Date.now();
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
      if (msg.type === 'pong') this.lastPongAt = Date.now();
      for (const fn of [...this.listeners]) fn(msg);
    };
    this.ws.onclose = () => {
      this.stopHeartbeat();
      if (this.connectTimer) clearTimeout(this.connectTimer);
      if (this.closedByUser) {
        this.emitStatus('closed');
      } else {
        this.scheduleReconnect();
      }
    };
    this.ws.onerror = () => {
      if (this.ws && this.ws.readyState !== WebSocket.OPEN) {
        this._lastError = '连接被拒绝或网络不可达';
      }
      // onclose 会随后触发并处理重连
    };
  }

  private scheduleReconnect(): void {
    if (this.closedByUser || !this.url) return;
    // 快速重连退避：1,1,2,3,5s（上限 5s，半开/抖动场景尽快恢复）
    const delay = Math.min(1000 * Math.min(this.retryCount + 1, 5), 5000);
    this.retryCount += 1;
    this.emitStatus('reconnecting');
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    // 心跳 15s 一次；若超过 35s 未收到任何 pong → 连接半开，强制重连
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.send({ type: 'ping' });
        if (Date.now() - this.lastPongAt > 35000) {
          this._lastError = '心跳超时（连接半开）';
          this.ws.close();
        }
      }
    }, 15000);
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
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
    this.stopHeartbeat();
    this.ws?.close();
    this.ws = null;
    this.emitStatus('closed');
  }

  private emitStatus(s: WsStatus): void {
    for (const fn of [...this.statusListeners]) fn(s);
  }
}
