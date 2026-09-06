import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { PhysicalPosition } from '@tauri-apps/api/dpi';
import { ScreenShareManager } from './app/screenShare';
import { getTurnCredentials } from './app/api';
import './App.css';

/**
 * 屏幕共享采集窗（共享端的采集发生在这里，而不是主窗口）。
 * 动机：WebView2/Chromium 对 getDisplayMedia 会强制绘制一条「正在共享」的浮条，
 * 且没有任何官方开关可隐藏——那就让采集发生在一个被移到屏幕外的独立窗口里，
 * 浮条跟着那个窗口一起离开视野，主窗口干干净净。
 *
 * 该窗口自持 WS 信令并承担共享端全部职责：screen:start、处理观看端 request、
 * offer/answer/candidate/bye、结束时的 screen:stop。主窗口经屏幕广播自动获知状态。
 */

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

function ShareWindow() {
  const params = useRef(new URLSearchParams(window.location.search));
  const room = params.current.get('room') ?? '';
  const [phase, setPhase] = useState<'ready' | 'sharing' | 'ended'>('ready');
  const [error, setError] = useState<string | null>(null);
  const mgrRef = useRef<ScreenShareManager | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const sharingRef = useRef(false);
  const offscreenRef = useRef(false);

  /** 共享开始后把窗口挪到屏幕外：浮条画在本窗口表面，随窗口一起离开视野 */
  const goOffscreen = () => {
    if (offscreenRef.current) return;
    offscreenRef.current = true;
    try {
      getCurrentWindow().setPosition(new PhysicalPosition(-32000, -32000));
    } catch {
      /* 浏览器环境忽略 */
    }
  };

  const sendStop = () => {
    try {
      wsRef.current?.send(JSON.stringify({ type: 'screen:stop', payload: { roomId: room } }));
    } catch {
      /* ignore */
    }
  };

  const beginShare = async () => {
    const token = readToken();
    if (!room || !token) {
      setError('缺少房间或登录信息，请从主窗口重新打开');
      return;
    }
    setError(null);
    // WebView2 的共享选择器渲染在本窗口内部（按窗口尺寸布局）：
    // 窗口创建时已是全尺寸，这里再留出布局时间，避免选择器按旧尺寸弹出被裁切
    await new Promise((r) => setTimeout(r, 400));
    const mgr = new ScreenShareManager();
    mgrRef.current = mgr;
    let ws: WebSocket | null = null;
    const send = (payload: object) => {
      try {
        ws?.send(JSON.stringify(payload));
      } catch {
        /* ignore */
      }
    };
    mgr.setSignalSender((to, rid, data) => send({ type: 'screen:signal', payload: { roomId: rid, to, data } }));
    mgr.setRemoteStreamHandler(() => undefined); // 共享端不收流
    try {
      await mgr.start(
        room,
        (to, rid, data) => send({ type: 'screen:signal', payload: { roomId: rid, to, data } }),
        () => {
          // 轨道结束（系统/条内停止）：广播结束并回到待命
          sendStop();
          sharingRef.current = false;
          setPhase('ended');
        },
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : '无法获取屏幕');
      return;
    }
    if (!mgr.isSharing) return; // 用户在系统选择器取消

    // 连接信令：hello → room:join → screen:start
    ws = new WebSocket(readServerUrl().replace(/^http/, 'ws') + '/ws');
    wsRef.current = ws;
    ws.onopen = () => send({ type: 'hello', payload: { token } });
    ws.onmessage = (ev) => {
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
          // 发送端也备好自建 TURN 凭据（观看端请求到来时才建 sender，异步就位即可）
          void getTurnCredentials(token)
            .then(({ iceServers }) => mgrRef.current?.setExtraIceServers(iceServers as unknown as RTCIceServer[]))
            .catch(() => undefined);
          send({ type: 'screen:start', payload: { roomId: room } });
          sharingRef.current = true;
          setPhase('sharing');
          break;
        case 'screen:signal':
          void mgr.handleSignal(String(msg.payload?.from ?? ''), String(msg.payload?.roomId ?? room), msg.payload?.data);
          break;
        case 'screen:stopped':
          // 主窗口代为停止：释放本地轨道并回到待命
          if (sharingRef.current) {
            sharingRef.current = false;
            mgr.stopAll();
            setPhase('ended');
          }
          break;
        case 'error':
          setError(String(msg.payload?.message ?? '连接出错'));
          break;
        default:
          break;
      }
    };
    ws.onclose = () => {
      if (sharingRef.current) {
        sharingRef.current = false;
        setPhase('ended');
      }
    };
    setInterval(() => send({ type: 'ping' }), 15000);

    // 共享已建立：窗口挪出屏幕（浮条随之不可见），主窗口经 screen:started 广播同步状态
    await new Promise((r) => setTimeout(r, 300));
    goOffscreen();
  };

  const stopShare = () => {
    mgrRef.current?.stopLocal(); // 触发 onSelfStop → screen:stop 广播
    sendStop();
    sharingRef.current = false;
    setPhase('ended');
    try {
      getCurrentWindow().setPosition(new PhysicalPosition(200, 200));
      offscreenRef.current = false;
    } catch {
      /* ignore */
    }
  };

  // 结束后自动销毁：位置已在屏幕外，重开共享由主窗口新建窗口
  useEffect(() => {
    if (phase !== 'ended') return;
    const t = setTimeout(() => {
      try {
        void getCurrentWindow().destroy();
      } catch {
        /* ignore */
      }
    }, 1200);
    return () => clearTimeout(t);
  }, [phase]);

  useEffect(() => {
    // 主窗口「停止共享」→ 停止采集
    let un1: (() => void) | undefined;
    let disposed = false;
    try {
      listen('share-stop', () => {
        if (sharingRef.current) stopShare();
      }).then((f) => {
        if (disposed) f();
        else un1 = f;
      });
    } catch {
      /* 浏览器环境 */
    }
    return () => {
      disposed = true;
      un1?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="share-window">
      <div className="share-card">
        <div className="share-title">共享屏幕 · {room ? `房间 ${room.slice(0, 8)}` : ''}</div>
        {error ? (
          <>
            <div className="share-error">{error}</div>
            <button className="btn ghost" onClick={() => setError(null)}>
              返回重试
            </button>
          </>
        ) : phase === 'ready' ? (
          <>
            <p className="share-sub" style={{ margin: '0 0 14px', textAlign: 'left' }}>点「开始共享」后，在弹出的选择器里选择屏幕 / 窗口，并用底部开关决定是否带上系统声音。</p>
            <button className="btn primary share-start" onClick={() => void beginShare()}>
              开始共享（选择屏幕 / 窗口）
            </button>
          </>
        ) : phase === 'sharing' ? (
          <>
            <div className="share-live">● 正在共享本房间屏幕</div>
            <div className="share-sub">在主窗口点「停止共享」结束</div>
          </>
        ) : (
          <div className="share-sub">共享已结束，窗口即将关闭…</div>
        )}
      </div>
    </div>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<ShareWindow />);
