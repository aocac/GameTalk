import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { ScreenShareManager } from './app/screenShare';
import './App.css';

/**
 * 屏幕共享独立观看窗。
 * MediaStream 不能跨 webview 传递，因此本窗口自持一条 WebSocket 信令连接（同源共享 localStorage 的 token）
 * 并建立自己的 RTCPeerConnection；观看结束/关窗时发 `bye` 让共享者释放中继连接。
 */

type Status = 'connecting' | 'live' | 'ended' | 'closed' | 'error';

function readToken(): string {
  try {
    const raw = localStorage.getItem('gametalk-auth');
    return raw ? (JSON.parse(raw)?.state?.token ?? '') : '';
  } catch {
    return '';
  }
}

function readServerUrl(): string {
  try {
    const raw = localStorage.getItem('gametalk-settings');
    const url = raw ? (JSON.parse(raw)?.state?.serverUrl ?? '') : '';
    return (url || 'http://127.0.0.1:8787').replace(/\/+$/, '');
  } catch {
    return 'http://127.0.0.1:8787';
  }
}

function ScreenWindow() {
  const params = useRef(new URLSearchParams(window.location.search));
  const sharer = params.current.get('sharer') ?? '';
  const room = params.current.get('room') ?? '';
  const name = params.current.get('name') ?? '';
  const [status, setStatus] = useState<Status>('connecting');
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [ice, setIce] = useState<string | undefined>(undefined);
  const byeRef = useRef<(() => void) | null>(null);
  const statusRef = useRef<Status>('connecting');
  statusRef.current = status;

  useEffect(() => {
    const token = readToken();
    if (!sharer || !room || !token) {
      setStatus('error');
      return;
    }
    const mgr = new ScreenShareManager();
    let ws: WebSocket | null = null;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    let disposed = false;

    const send = (payload: object) => {
      try {
        ws?.send(JSON.stringify(payload));
      } catch {
        /* 连接已断 */
      }
    };
    byeRef.current = () => send({ type: 'screen:signal', payload: { roomId: room, to: sharer, data: { type: 'bye' } } });

    mgr.setSignalSender((to, rid, data) => send({ type: 'screen:signal', payload: { roomId: rid, to, data } }));
    mgr.setRemoteStreamHandler((_id, s) => {
      setStream(s);
      setStatus('live');
    });
    mgr.setIceStateHandler((_id, st) => setIce(st));

    ws = new WebSocket(readServerUrl().replace(/^http/, 'ws') + '/ws');
    ws.onopen = () => send({ type: 'hello', payload: { token } });
    ws.onmessage = (ev) => {
      if (disposed) return;
      let msg: { type: string; payload?: Record<string, unknown> };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      switch (msg.type) {
        case 'hello:ok':
          send({ type: 'room:join', payload: { roomId: room } });
          break;
        case 'room:joined':
          // 收到加入回执后再请求观看：此时本连接已在房间广播列表里
          mgr.watch(sharer, room);
          break;
        case 'screen:signal':
          void mgr.handleSignal(String(msg.payload?.from ?? ''), String(msg.payload?.roomId ?? room), msg.payload?.data);
          break;
        case 'screen:stopped':
          setStatus('ended');
          setStream(null);
          window.setTimeout(() => void closeWindow(), 2500);
          break;
        case 'error':
          setStatus('error');
          break;
        default:
          break;
      }
    };
    ws.onclose = () => {
      if (!disposed && statusRef.current !== 'ended') setStatus('closed');
    };
    pingTimer = setInterval(() => send({ type: 'ping' }), 15000);

    return () => {
      disposed = true;
      if (pingTimer) clearInterval(pingTimer);
      byeRef.current?.();
      mgr.stopAll();
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 关窗：先发 bye 让共享者释放中继，再关原生窗口 */
  const closeWindow = async () => {
    byeRef.current?.();
    byeRef.current = null;
    try {
      await getCurrentWindow().close();
    } catch {
      window.close();
    }
  };

  useEffect(() => {
    // 原生标题栏 ✕：先补发 bye 再放行关闭
    try {
      const un = getCurrentWindow().onCloseRequested(() => {
        byeRef.current?.();
      });
      return () => {
        void un.then((f) => f());
      };
    } catch {
      return undefined; // 浏览器环境无 Tauri
    }
  }, []);

  const failed = ice === 'failed' || ice === 'disconnected' || ice === 'closed';
  const statusText =
    status === 'live'
      ? `正在观看 ${name} 的屏幕共享`
      : status === 'ended'
        ? '共享已结束，窗口即将关闭'
        : status === 'closed'
          ? '连接已断开（可关闭窗口后重新观看）'
          : status === 'error'
            ? '无法建立观看连接'
            : `正在建立连接…${ice ? `（${ice}）` : ''}`;
  return (
    <div className="screen-viewer" style={{ left: 0, top: 0, width: '100%', height: '100%', borderRadius: 0, border: 'none' }}>
      <div className="screen-viewer-head" style={{ cursor: 'default' }}>
        <span>{statusText}</span>
        <button className="screen-viewer-close" title="关闭" onClick={() => void closeWindow()}>
          ✕
        </button>
      </div>
      <div className="screen-stage">
        <video
          ref={(el) => {
            if (el && stream && el.srcObject !== stream) {
              el.muted = true;
              el.playsInline = true;
              el.srcObject = stream;
              void el.play().catch(() => {});
            }
          }}
          autoPlay
          playsInline
          muted
          className="screen-video"
          style={{ background: status === 'live' ? '#000' : '#101318' }}
          onClick={(e) => {
            const el = e.target as HTMLVideoElement;
            el.muted = true;
            void el.play().catch(() => {});
          }}
        />
        {status !== 'live' && (
          <div className="screen-wait">
            {status === 'connecting' && failed
              ? `连接失败（${ice}）——双方网络可能受限，请稍后重试`
              : status === 'connecting'
                ? '正在与共享者建立 P2P 连接…'
                : statusText}
          </div>
        )}
      </div>
    </div>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<ScreenWindow />);
