import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { emit } from '@tauri-apps/api/event';
import { ScreenShareManager, type ShareStats } from './app/screenShare';
import { SignalSocket, wsUrlOfServerUrl } from './app/signalSocket';
import { getTurnCredentials } from './app/api';
import './App.css';
import { applyStoredTheme } from './app/theme';

/**
 * 屏幕共享独立观看窗。
 * MediaStream 不能跨 webview 传递，因此本窗口自持一条可自动重连的 WS 信令连接（同源共享 localStorage 的 token）
 * 并建立自己的 RTCPeerConnection；观看结束/关窗时发 `bye` 让共享者释放对应连接，并通知主窗口更新状态。
 * 信令重连后带原 cid 重发 request——共享端对已连通的连接保持不动，媒体不中断。
 */

type Status = 'connecting' | 'live' | 'ended' | 'error';

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
  const [stats, setStats] = useState<ShareStats | null>(null);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const byeRef = useRef<(() => void) | null>(null);
  const sockRef = useRef<SignalSocket | null>(null);
  const statsTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const statusRef = useRef<Status>('connecting');
  statusRef.current = status;

  useEffect(() => {
    const token = readToken();
    if (!sharer || !room || !token) {
      setStatus('error');
      return;
    }
    const mgr = new ScreenShareManager();
    let disposed = false;
    let watching = false;

    const sock = new SignalSocket({
      url: wsUrlOfServerUrl(readServerUrl()),
      token,
      roomId: room,
      onMessage: (msg) => {
        switch (msg.type) {
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
      },
      onJoined: () => {
        // 首次连上：拿自建 TURN 凭据（receiver 的 ICE 配置构造时固定）后请求观看；
        // 重连：带原 cid 重发 request，已连通的媒体连接不受影响
        void getTurnCredentials(token)
          .then(({ iceServers, relayMaxBps }) => {
            mgr.setExtraIceServers(iceServers as unknown as RTCIceServer[]);
            mgr.setRelayMaxBps(relayMaxBps);
          })
          .catch(() => undefined)
          .then(() => {
            if (disposed) return;
            if (watching) mgr.resendRequests();
            else {
              mgr.watch(sharer, room);
              watching = true;
            }
          });
      },
    });
    sockRef.current = sock;
    // 关窗必须走带 cid 的 bye：不带 cid 的 bye 会被共享端当作「释放该用户全部连接」，
    // 同账号在主窗内嵌观看 + 独立窗同时看时，关掉一个会把另一个也断掉。
    byeRef.current = () => mgr.stopWatching(sharer);

    mgr.setSignalSender((to, rid, data) => sock.send({ type: 'screen:signal', payload: { roomId: rid, to, data } }));
    mgr.setRemoteStreamHandler((_id, s) => {
      setStream(s);
      setStatus('live');
    });
    mgr.setIceStateHandler((_id, st) => setIce(st));
    sock.connect();

    statsTimerRef.current = setInterval(() => setStats(mgr.snapshot()), 1500);

    return () => {
      disposed = true;
      if (statsTimerRef.current) clearInterval(statsTimerRef.current);
      byeRef.current?.();
      void emit('screen-window-closed', { sharer }).catch(() => undefined);
      mgr.stopAll();
      sock.close();
      sockRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 关窗：destroy 不经过关闭请求链路（最可靠），逐级回落 */
  const closeWindow = async () => {
    byeRef.current?.();
    byeRef.current = null;
    try {
      await emit('screen-window-closed', { sharer });
    } catch {
      /* 浏览器环境 */
    }
    try {
      await getCurrentWindow().destroy();
      return;
    } catch {
      /* 回落 close */
    }
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
        void emit('screen-window-closed', { sharer }).catch(() => undefined);
      });
      return () => {
        void un.then((f) => f());
      };
    } catch {
      return undefined; // 浏览器环境无 Tauri
    }
  }, [sharer]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !stream) return;
    // 先静音起播（绕过自动播放策略），随后由下面的音量/静音 effect 按用户状态同步
    v.muted = true;
    v.playsInline = true;
    v.srcObject = stream;
    void v.play().catch(() => {});
    return () => {
      try {
        v.pause();
      } catch {
        /* ignore */
      }
      v.srcObject = null;
    };
  }, [stream]);

  // 音量/静音的唯一来源：起播后（含音频轨晚到的情况）都以此为准
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.volume = volume;
    v.muted = muted;
    if (!muted) void v.play().catch(() => {});
  }, [volume, muted, stream]);

  const hasAudio = !!stream && stream.getAudioTracks().length > 0;
  const peer = stats?.peers[0];
  const res = peer && peer.width ? `${peer.width}×${peer.height}` : '';
  const kbps = peer && peer.kbps ? (peer.kbps >= 1000 ? `${(peer.kbps / 1000).toFixed(1)} Mbps` : `${peer.kbps} kbps`) : '';
  const fps = peer && peer.fps ? `${peer.fps} fps` : '';
  const qualityLine = [res, kbps, fps].filter(Boolean).join(' · ');

  const toggleFullscreen = async () => {
    try {
      const next = !fullscreen;
      await getCurrentWindow().setFullscreen(next);
      setFullscreen(next);
    } catch {
      // 浏览器环境回落 DOM 全屏
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await videoRef.current?.requestFullscreen();
      } catch {
        /* ignore */
      }
    }
  };

  const togglePip = async () => {
    try {
      const v = videoRef.current as (HTMLVideoElement & { requestPictureInPicture?: () => Promise<unknown> }) | null;
      if (!v?.requestPictureInPicture) return;
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await v.requestPictureInPicture();
    } catch {
      /* 不支持画中画时忽略 */
    }
  };

  const failed = ice?.includes('failed') || ice?.includes('disconnected');
  const statusText =
    status === 'live'
      ? `正在观看 ${name} 的屏幕共享`
      : status === 'ended'
        ? '共享已结束，窗口即将关闭'
        : status === 'error'
          ? '无法建立观看连接'
          : `正在建立连接…${ice ? `（${ice}）` : ''}`;
  return (
    <div className="screen-viewer" style={{ left: 0, top: 0, width: '100%', height: '100%', borderRadius: 0, border: 'none' }}>
      <div className="screen-viewer-head" style={{ cursor: 'default' }}>
        <span className="screen-viewer-title">{statusText}</span>
        {status === 'live' && qualityLine && <span className="screen-viewer-stats">{qualityLine}</span>}
        <span className="screen-viewer-tools">
          {hasAudio && (
            <>
              <button className="screen-tool" title={muted ? '取消静音' : '静音'} onClick={() => setMuted((m) => !m)}>
                {muted ? '🔇' : '🔊'}
              </button>
              <input
                className="screen-volume"
                type="range"
                min={0}
                max={100}
                value={Math.round(volume * 100)}
                title={`音量 ${Math.round(volume * 100)}%`}
                onChange={(e) => {
                  setVolume(Number(e.target.value) / 100);
                  if (Number(e.target.value) > 0) setMuted(false);
                }}
              />
            </>
          )}
          <button className="screen-tool" title="画中画" onClick={() => void togglePip()}>
            ⧉
          </button>
          <button className="screen-tool" title={fullscreen ? '退出全屏' : '全屏'} onClick={() => void toggleFullscreen()}>
            {fullscreen ? '⤡' : '⤢'}
          </button>
        </span>
      </div>
      <div className="screen-stage">
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="screen-video"
          style={{ background: status === 'live' ? '#000' : '#101318' }}
          onClick={(e) => {
            const el = e.target as HTMLVideoElement;
            if (stream && stream.getAudioTracks().length > 0) {
              el.muted = false;
              setMuted(false);
            }
            void el.play().catch(() => {});
          }}
        />
        {status !== 'live' && (
          <div className="screen-wait">
            {status === 'connecting' && failed
              ? `连接中断（${ice}），正在自动重连…`
              : status === 'connecting'
                ? '正在与共享者建立 P2P 连接…'
                : statusText}
          </div>
        )}
      </div>
    </div>
  );
}

applyStoredTheme();

createRoot(document.getElementById('root') as HTMLElement).render(<ScreenWindow />);
