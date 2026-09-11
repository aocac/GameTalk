import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { getCurrentWindow, currentMonitor, primaryMonitor } from '@tauri-apps/api/window';
import { PhysicalPosition, PhysicalSize } from '@tauri-apps/api/dpi';
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { ScreenShareManager, QUALITY_OPTIONS, QUALITY_PRESETS, type ShareQuality, type ShareStats } from './app/screenShare';
import { SignalSocket, wsUrlOfServerUrl } from './app/signalSocket';
import { getTurnCredentials } from './app/api';
import './App.css';
import { applyStoredTheme } from './app/theme';

/**
 * 屏幕共享采集窗 = 共享端全部职责所在：
 * - 采集（getDisplayMedia 必须由本窗口发起，WebView2 的「正在共享」浮条画在本窗口表面）
 * - 自持一条可自动重连的 WS 信令（screen:start / request / offer / answer / candidate / bye）
 * - 共享开始后把窗口收成屏幕右下角的常驻控制条：本地预览 + 观看人数 + 实际码率/分辨率/帧率
 *   + 画质档位切换 + 停止共享。不再依赖主窗口横幅，游戏里也能直接停。
 *
 * 浮条：WebView2 的采集提示条是系统行为（无官方开关），这里仍用 Win32 命令周期性隐藏。
 */

// 控制条尺寸以「逻辑像素（CSS px）」为准，下发窗口时再乘显示器缩放系数。
// 曾经的 bug：直接把 384×138 当物理像素设给窗口，在 150% 缩放的屏幕上只有 256px 逻辑宽，
// 于是「正在共享」被挤成两行、按钮被压扁裁切。窗口尺寸必须与 DPI 无关。
//
// 控制条只放「看一眼就知道状态」的东西：本地预览 + 正在共享 + 观看人数 + 关键指标 + 停止。
// 画质档位 / 带宽预算 / 静音提示音都在应用内（设置窗口「屏幕共享」页），不占常驻浮窗的地方。
const CONTROL_W = 460;
const CONTROL_H = 104;
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
      quality: (s.shareQuality as ShareQuality) || 'auto',
      budgetMbps: Number(s.shareBudgetMbps ?? 12) || 12,
      muteOwn: s.shareMuteOwnSounds !== false,
    };
  } catch {
    return { serverUrl: 'http://127.0.0.1:8787', quality: 'balanced', budgetMbps: 12, muteOwn: true };
  }
}

function ShareWindow() {
  const params = useRef(new URLSearchParams(window.location.search));
  const room = params.current.get('room') ?? '';
  const initial = useRef(readSettings());
  const [phase, setPhase] = useState<'ready' | 'sharing' | 'ended'>('ready');
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<ShareStats | null>(null);
  /** 生效画质档位（控制条不再渲染档位按钮，但设置窗口改档要能作用到进行中的共享） */
  const qualityRef = useRef<ShareQuality>(initial.current.quality);
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
      // 用窗口所在显示器（多显示器不同缩放时 primaryMonitor 会算错位置/尺寸）
      const mon = (await currentMonitor()) ?? (await primaryMonitor());
      const scale = mon?.scaleFactor || window.devicePixelRatio || 1;
      await win.setSize(new PhysicalSize(Math.round(CONTROL_W * scale), Math.round(CONTROL_H * scale)));
      if (mon) {
        const x = mon.position.x + mon.size.width - CONTROL_W * scale - MARGIN * scale;
        const y = mon.position.y + mon.size.height - CONTROL_H * scale - MARGIN * scale;
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
    mgr.setQuality(qualityRef.current);
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
          // 被顶号：共享已经无法继续，收尾关窗（不这样做会留一个空跑的控制条）
          if (msg.payload?.code === 'session_replaced') stopShare();
        }
      },
      // 每次（重）连上房间：重新登记共享 + 重发观看请求，媒体连接不受影响
      onJoined: () => {
        void getTurnCredentials(token)
          .then(({ iceServers, relayMaxBps }) => {
            mgr.setExtraIceServers(iceServers as unknown as RTCIceServer[]);
            mgr.setRelayMaxBps(relayMaxBps);
          })
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
    if (mgr.hasAudio && initial.current.muteOwn) void emit('share:audio-mute', { muted: true }).catch(() => undefined);
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
      // 设置窗口里改了画质/预算 → 立刻作用到进行中的共享（控制条上已不再放这些控件）
      void listen<{ quality?: ShareQuality; budgetMbps?: number }>('share:config', (e) => {
        const q = e.payload?.quality;
        if (q && QUALITY_OPTIONS.includes(q)) {
          qualityRef.current = q;
          mgrRef.current?.setQuality(q);
        }
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

  // 预览：只在进入共享态时挂一次本地流（不要依赖 stats，否则每 1.5s 重挂一次会闪）
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
  }, [phase]);

  const peer = stats?.peers[0];
  const res = peer && peer.width ? `${peer.width}×${peer.height}` : '—';
  const kbps = stats ? (stats.totalKbps >= 1000 ? `${(stats.totalKbps / 1000).toFixed(1)} Mbps` : `${stats.totalKbps} kbps`) : '—';
  const fps = peer && peer.fps ? `${peer.fps} fps` : '—';

  if (phase === 'sharing') {
    // 指标段可省略（前缀保留最关键的分辨率/码率），告警段不可截断——中转限速是最该被看到的信息
    const metrics = `${res} · ${kbps} · ${fps}`;
    const fullStatus = `${metrics}${stats ? ` · ${QUALITY_PRESETS[stats.effectiveQuality].label}` : ''}${
      stats?.relayed ? ' · 服务器中转（已限码率）' : ''
    }${stats?.audio ? ' · 含音频' : ''}${stats?.paramError ? ` · 参数下发失败(${stats.paramError})` : ''}`;
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
          <div className="share-bar-stats" title={fullStatus}>
            <span className="share-bar-metrics">{metrics}</span>
            {stats?.relayed && (
              <span className="share-stat-warn" title="本路媒体经服务器 TURN 中继，码率已按服务端下发的上限压缩">
                ⚠ 服务器中转
              </span>
            )}
            {stats?.audio && <span className="share-stat-tag">含音频</span>}
            {stats?.paramError && (
              <span className="share-stat-warn" title={`参数下发被拒：${stats.paramError}`}>
                ⚠ 参数失败
              </span>
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

applyStoredTheme();
// 透明窗口：让页面背景也透明，圆角由卡片自己负责（否则四角有白边）
document.documentElement.dataset.window = 'share';

createRoot(document.getElementById('root') as HTMLElement).render(<ShareWindow />);
