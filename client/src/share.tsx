import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { getCurrentWindow, primaryMonitor } from '@tauri-apps/api/window';
import { PhysicalPosition, PhysicalSize } from '@tauri-apps/api/dpi';
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { ScreenShareManager, QUALITY_PRESETS, type ShareQuality, type ShareStats } from './app/screenShare';
import { SignalSocket, wsUrlOfServerUrl } from './app/signalSocket';
import { getTurnCredentials } from './app/api';
import './App.css';

/**
 * 屏幕共享采集窗 = 共享端全部职责所在：
 * - 采集（getDisplayMedia 必须由本窗口发起，WebView2 的「正在共享」浮条画在本窗口表面）
 * - 自持一条可自动重连的 WS 信令（screen:start / request / offer / answer / candidate / bye）
 * - 共享开始后把窗口收成屏幕右下角的常驻控制条：本地预览 + 观看人数 + 实际码率/分辨率/帧率
 *   + 画质档位切换 + 停止共享。不再依赖主窗口横幅，游戏里也能直接停。
 *
 * 浮条：WebView2 的采集提示条是系统行为（无官方开关），这里仍用 Win32 命令周期性隐藏。
 */

const CONTROL_W = 384;
const CONTROL_H = 138;
const MARGIN = 24;

function readToken(): string {
  try {
    const raw = localStorage.getItem('gametalk-auth');
    return raw ? (JSON.parse(raw)?.state?.token ?? '') : '';
  } catch {
    return '';
  }
}

function readSettings(): { serverUrl: string; quality: ShareQuality; budgetMbps: number; muteOwn: boolean } {
  try {
    const raw = localStorage.getItem('gametalk-settings');
    const s = raw ? (JSON.parse(raw)?.state ?? {}) : {};
    return {
      serverUrl: String(s.serverUrl || 'http://127.0.0.1:8787').replace(/\/+$/, ''),
      quality: (s.shareQuality as ShareQuality) || 'balanced',
      budgetMbps: Number(s.shareBudgetMbps ?? 12) || 12,
      muteOwn: s.shareMuteOwnSounds !== false,
    };
  } catch {
    return { serverUrl: 'http://127.0.0.1:8787', quality: 'balanced', budgetMbps: 12, muteOwn: true };
  }
}

/** 把设置里的选择写回（控制条上切档位要持久化） */
function persistSetting(key: string, value: unknown): void {
  try {
    const raw = localStorage.getItem('gametalk-settings');
    const parsed = raw ? JSON.parse(raw) : { state: {}, version: 0 };
    parsed.state = { ...(parsed.state ?? {}), [key]: value };
    localStorage.setItem('gametalk-settings', JSON.stringify(parsed));
  } catch {
    /* 忽略 */
  }
}

function ShareWindow() {
  const params = useRef(new URLSearchParams(window.location.search));
  const room = params.current.get('room') ?? '';
  const initial = useRef(readSettings());
  const [phase, setPhase] = useState<'ready' | 'sharing' | 'ended'>('ready');
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<ShareStats | null>(null);
  const [quality, setQuality] = useState<ShareQuality>(initial.current.quality);
  const [muteOwn, setMuteOwn] = useState(initial.current.muteOwn);
  const mgrRef = useRef<ScreenShareManager | null>(null);
  const sockRef = useRef<SignalSocket | null>(null);
  const sharingRef = useRef(false);
  const startingRef = useRef(false);
  const barTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const statsTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const previewRef = useRef<HTMLVideoElement | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);

  const sendStop = () => {
    sockRef.current?.send({ type: 'screen:stop', payload: { roomId: room } });
  };

  /** 共享建立后把窗口收成右下角控制条 */
  const becomeControlBar = async () => {
    try {
      const win = getCurrentWindow();
      const mon = await primaryMonitor();
      await win.setSize(new PhysicalSize(CONTROL_W, CONTROL_H));
      if (mon) {
        const dpr = window.devicePixelRatio || 1;
        const x = mon.position.x + mon.size.width - CONTROL_W * dpr - MARGIN * dpr;
        const y = mon.position.y + mon.size.height - CONTROL_H * dpr - MARGIN * dpr;
        await win.setPosition(new PhysicalPosition(Math.round(x), Math.round(y)));
      }
      await win.setAlwaysOnTop(true);
      await win.show();
    } catch {
      /* 浏览器环境忽略 */
    }
  };

  /** 周期性隐藏 WebView2 的采集提示条（切换音源等场景会重新出现） */
  const startBarHiding = () => {
    const hide = () => void invoke('hide_webview2_capture_bar').catch(() => undefined);
    hide();
    if (barTimerRef.current) clearInterval(barTimerRef.current);
    barTimerRef.current = setInterval(hide, 3000);
  };

  const beginShare = async () => {
    if (startingRef.current) return;
    startingRef.current = true;
    const token = readToken();
    if (!room || !token) {
      startingRef.current = false;
      setError('缺少房间或登录信息，请从主窗口重新打开');
      return;
    }
    setError(null);
    // WebView2 的共享选择器按调用时刻的窗口尺寸布局：创建时已是全尺寸，再留一点沉降时间
    await new Promise((r) => setTimeout(r, 400));

    const mgr = new ScreenShareManager();
    mgrRef.current = mgr;
    mgr.setQuality(quality);
    mgr.setBudgetBps(initial.current.budgetMbps * 1_000_000);

    const sock = new SignalSocket({
      url: wsUrlOfServerUrl(initial.current.serverUrl),
      token,
      roomId: room,
      onMessage: (msg) => {
        if (msg.type === 'screen:signal') {
          void mgr.handleSignal(String(msg.payload?.from ?? ''), String(msg.payload?.roomId ?? room), msg.payload?.data);
        } else if (msg.type === 'error') {
          setError(String(msg.payload?.message ?? '连接出错'));
        }
      },
      // 每次（重）连上房间：重新登记共享 + 重发观看请求，媒体连接不受影响
      onJoined: () => {
        void getTurnCredentials(token)
          .then(({ iceServers }) => mgr.setExtraIceServers(iceServers as unknown as RTCIceServer[]))
          .catch(() => undefined);
        sock.send({ type: 'screen:start', payload: { roomId: room } });
      },
    });
    sockRef.current = sock;
    mgr.setSignalSender((to, rid, data) => sock.send({ type: 'screen:signal', payload: { roomId: rid, to, data } }));

    try {
      await mgr.start(room, (to, rid, data) => sock.send({ type: 'screen:signal', payload: { roomId: rid, to, data } }), () => {
        // 轨道结束（系统/提示条内停止）：广播结束并回到待命
        sendStop();
        sharingRef.current = false;
        setPhase('ended');
      });
    } catch (e) {
      startingRef.current = false;
      setError(e instanceof Error ? e.message : '无法获取屏幕');
      return;
    }
    if (!mgr.isSharing) {
      startingRef.current = false; // 用户在系统选择器取消
      return;
    }

    localStreamRef.current = mgr.localStreamForPreview();
    sock.connect();
    sharingRef.current = true;
    setPhase('sharing');
    startingRef.current = false;
    // 共享含音频时默认静音本应用提示音，避免自己的提示音被采进共享流
    if (mgr.hasAudio && muteOwn) void emit('share:audio-mute', { muted: true }).catch(() => undefined);
    await becomeControlBar();
    startBarHiding();
    statsTimerRef.current = setInterval(() => {
      const snap = mgr.snapshot();
      setStats(snap);
      void emit('share:stats', {
        viewers: snap.peers.length,
        kbps: snap.totalKbps,
        audio: snap.audio,
        peer: snap.peers[0] ?? null,
      }).catch(() => undefined);
    }, 1500);
  };

  const stopShare = () => {
    mgrRef.current?.stopLocal();
    sendStop();
    sharingRef.current = false;
    if (barTimerRef.current) {
      clearInterval(barTimerRef.current);
      barTimerRef.current = null;
    }
    if (statsTimerRef.current) {
      clearInterval(statsTimerRef.current);
      statsTimerRef.current = null;
    }
    void emit('share:audio-mute', { muted: false }).catch(() => undefined);
    setPhase('ended');
  };

  const changeQuality = (q: ShareQuality) => {
    setQuality(q);
    persistSetting('shareQuality', q);
    mgrRef.current?.setQuality(q);
  };

  const toggleMuteOwn = () => {
    const next = !muteOwn;
    setMuteOwn(next);
    persistSetting('shareMuteOwnSounds', next);
    void emit('share:audio-mute', { muted: next && !!stats?.audio }).catch(() => undefined);
  };

  // 结束后自动销毁（重开共享由主窗口新建窗口）
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
    let offStop: (() => void) | undefined;
    let offQuality: (() => void) | undefined;
    let disposed = false;
    try {
      void listen('share-stop', () => {
        if (sharingRef.current) stopShare();
      }).then((f) => (disposed ? f() : (offStop = f)));
      // 主窗口设置里改了画质 → 同步到控制条
      void listen<{ quality?: ShareQuality; budgetMbps?: number }>('share:config', (e) => {
        const q = e.payload?.quality;
        if (q && QUALITY_PRESETS[q]) changeQuality(q);
        if (e.payload?.budgetMbps) mgrRef.current?.setBudgetBps(e.payload.budgetMbps * 1_000_000);
      }).then((f) => (disposed ? f() : (offQuality = f)));
    } catch {
      /* 浏览器环境 */
    }
    return () => {
      disposed = true;
      offStop?.();
      offQuality?.();
      sockRef.current?.close();
      sockRef.current = null;
      mgrRef.current?.stopAll();
      if (barTimerRef.current) clearInterval(barTimerRef.current);
      if (statsTimerRef.current) clearInterval(statsTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 关窗（Alt+F4 / 标题栏）＝停止共享
  useEffect(() => {
    try {
      const un = getCurrentWindow().onCloseRequested((e) => {
        if (sharingRef.current) {
          e.preventDefault();
          stopShare();
        }
      });
      return () => void un.then((f) => f());
    } catch {
      return undefined;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 预览：控制条阶段把本地流挂到 video 上
  useEffect(() => {
    const v = previewRef.current;
    const s = localStreamRef.current;
    if (!v || !s || phase !== 'sharing') return;
    v.muted = true;
    v.playsInline = true;
    v.srcObject = s;
    void v.play().catch(() => undefined);
    return () => {
      try {
        v.pause();
      } catch {
        /* ignore */
      }
      v.srcObject = null;
    };
  }, [phase, stats]);

  const peer = stats?.peers[0];
  const res = peer && peer.width ? `${peer.width}×${peer.height}` : '—';
  const kbps = stats ? (stats.totalKbps >= 1000 ? `${(stats.totalKbps / 1000).toFixed(1)} Mbps` : `${stats.totalKbps} kbps`) : '—';
  const fps = peer && peer.fps ? `${peer.fps} fps` : '—';

  if (phase === 'sharing') {
    return (
      <div className="share-bar" data-tauri-drag-region>
        <video ref={previewRef} className="share-bar-preview" muted playsInline />
        <div className="share-bar-main">
          <div className="share-bar-top" data-tauri-drag-region>
            <span className="share-bar-dot">●</span>
            <span className="share-bar-live">正在共享</span>
            <span className="share-bar-viewers">{(stats?.peers.length ?? 0) > 0 ? `${stats?.peers.length} 人观看` : '等待观看'}</span>
            <button className="share-bar-close" title="停止共享" onClick={stopShare}>
              ■
            </button>
          </div>
          <div className="share-bar-stats">
            {res} · {kbps} · {fps}
            {stats?.audio ? ' · 含音频' : ''}
          </div>
          <div className="share-bar-actions">
            {(Object.keys(QUALITY_PRESETS) as ShareQuality[]).map((q) => (
              <button
                key={q}
                className={`share-chip${quality === q ? ' active' : ''}`}
                title={`单路上限 ${(QUALITY_PRESETS[q].maxBitrate / 1_000_000).toFixed(1)}Mbps`}
                onClick={() => changeQuality(q)}
              >
                {QUALITY_PRESETS[q].label}
              </button>
            ))}
            {stats?.audio && (
              <button className={`share-chip${muteOwn ? ' active' : ''}`} title="共享音频期间静音本应用提示音" onClick={toggleMuteOwn}>
                静音提示音
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="share-window">
      <div className="share-card">
        <div className="share-title" data-tauri-drag-region>
          共享屏幕 · {room ? `房间 ${room.slice(0, 8)}` : ''}
        </div>
        {error ? (
          <>
            <div className="share-error">{error}</div>
            <button className="btn ghost" onClick={() => setError(null)}>
              返回重试
            </button>
          </>
        ) : phase === 'ready' ? (
          <>
            <p className="share-sub" style={{ margin: '0 0 14px', textAlign: 'left' }}>
              点「开始共享」后，在弹出的选择器里选择屏幕 / 窗口，并用底部开关决定是否带上系统声音。共享开始后本窗口会收成右下角的小控制条。
            </p>
            <button className="btn primary share-start" onClick={() => void beginShare()}>
              开始共享（选择屏幕 / 窗口）
            </button>
          </>
        ) : (
          <div className="share-sub">共享已结束，窗口即将关闭…</div>
        )}
      </div>
    </div>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<ShareWindow />);
