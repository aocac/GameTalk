import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { getCurrentWindow, primaryMonitor } from '@tauri-apps/api/window';
import { PhysicalSize, PhysicalPosition } from '@tauri-apps/api/dpi';
import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event';
import './overlay.css';
import type { ChatMessage } from './app/types';

interface OverlayConfig {
  scale: number;
  durationSec: number;
}

const DEFAULT_CONFIG: OverlayConfig = { scale: 1, durationSec: 6 };
const MAX_ITEMS = 5;
const BASE_WIDTH = 380;
const BASE_HEIGHT = 180;
const FADE_MS = 350;

function MiniAvatar({ name, url, size = 20 }: { name: string; url?: string | null; size?: number }) {
  if (url) {
    return (
      <img
        className="overlay-avatar-img"
        src={url}
        alt=""
        style={{ width: size, height: size }}
        onError={(e) => {
          (e.target as HTMLImageElement).style.display = 'none';
        }}
      />
    );
  }
  const initials = (name || '?').slice(0, 2).toUpperCase();
  const hue = [...(name || '')].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  return (
    <span
      className="overlay-avatar"
      style={{ width: size, height: size, background: `hsl(${hue} 45% 42%)`, color: '#fff', fontSize: size * 0.45 }}
    >
      {initials}
    </span>
  );
}

function OverlayApp() {
  const [items, setItems] = useState<ChatMessage[]>([]);
  const [config, setConfig] = useState<OverlayConfig>(DEFAULT_CONFIG);
  const [adjusting, setAdjusting] = useState(false);
  const [fading, setFading] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const configRef = useRef(config);
  configRef.current = config;
  const scaleRef = useRef(config.scale);
  const lastPos = useRef<{ x: number; y: number } | null>(null);
  const adjustingRef = useRef(false);
  const winRef = useRef<ReturnType<typeof getCurrentWindow> | null>(null);

  // 点击穿透 + 永不聚焦：消息 Overlay 不干扰游戏操作
  useEffect(() => {
    const win = getCurrentWindow();
    winRef.current = win;
    void win.setIgnoreCursorEvents(true);
  }, []);

  const clearTimers = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    if (fadeTimer.current) clearTimeout(fadeTimer.current);
    hideTimer.current = null;
    fadeTimer.current = null;
  };

  const scheduleHide = () => {
    clearTimers();
    const durMs = configRef.current.durationSec * 1000;
      fadeTimer.current = setTimeout(() => {
        setFading(true);
        hideTimer.current = setTimeout(() => {
          const win = winRef.current;
          if (win) void win.hide();
          setFading(false);
          setPreviewing(false);
          setItems([]);
        }, FADE_MS);
      }, Math.max(durMs - FADE_MS, 100));
  };

  useEffect(() => {
    let unlistenAppend: UnlistenFn | undefined;
    let unlistenConfig: UnlistenFn | undefined;
    let unlistenAdjust: UnlistenFn | undefined;
    let unlistenPreview: UnlistenFn | undefined;
    let cancelled = false;

    void listen<ChatMessage>('overlay:append', (e) => {
      if (cancelled) return;
      setItems((prev) => [...prev, e.payload].slice(-MAX_ITEMS));
      setFading(false);
      clearTimers();
      const win = winRef.current;
      if (win) {
        // 若处于调整模式残留，自动退出并恢复点击穿透，确保消息可见
        if (adjustingRef.current) {
          setAdjusting(false);
          adjustingRef.current = false;
          void win.setIgnoreCursorEvents(true);
        }
        void win.show();
      }
      scheduleHide();
    }).then((off) => (unlistenAppend = off));

    void listen<OverlayConfig>('overlay:config', (e) => {
      if (cancelled) return;
      setConfig((prev) => ({ ...prev, ...e.payload }));
      scaleRef.current = e.payload.scale ?? scaleRef.current;
    }).then((off) => (unlistenConfig = off));

    // 位置预览：设置里调整位置/大小后显示 3 秒确认效果
    void listen('overlay:preview', () => {
      if (cancelled) return;
      const win = winRef.current;
      if (!win) return;
      setFading(false);
      setPreviewing(true);
      if (adjustingRef.current) {
        setAdjusting(false);
        adjustingRef.current = false;
        void win.setIgnoreCursorEvents(true);
      }
      scheduleHide();
    }).then((off) => (unlistenPreview = off));

    void listen<{ active: boolean }>('overlay:adjust', (e) => {
      if (cancelled) return;
      const active = e.payload.active;
      setAdjusting(active);
      adjustingRef.current = active;
      const win = winRef.current;
      if (!win) return;
      void win.setIgnoreCursorEvents(!active);
      if (active) {
        clearTimers();
        setFading(false);
        void win.show();
      } else {
        // 退出调整：保存并应用
        void win.outerPosition().then((pos) => {
          lastPos.current = { x: pos.x, y: pos.y };
          void emit('overlay:adjust-done', { position: lastPos.current, scale: Math.round(scaleRef.current * 100) / 100 });
        });
        void win.hide();
      }
    }).then((off) => (unlistenAdjust = off));

    return () => {
      cancelled = true;
      unlistenAppend?.();
      unlistenConfig?.();
      unlistenAdjust?.();
      unlistenPreview?.();
      clearTimers();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 调整模式：滚轮缩放
  const onWheel = (e: React.WheelEvent) => {
    if (!adjusting) return;
    e.preventDefault();
    const win = winRef.current;
    if (!win) return;
    const dpr = window.devicePixelRatio || 1;
    const next = Math.min(2, Math.max(0.5, Math.round((scaleRef.current + (e.deltaY < 0 ? 0.1 : -0.1)) * 100) / 100));
    scaleRef.current = next;
    void win.setSize(new PhysicalSize(Math.round(BASE_WIDTH * next * dpr), Math.round(BASE_HEIGHT * next * dpr)));
  };

  // 调整模式：纯 JS 拖拽（mousedown 记偏移 → mousemove setPosition → mouseup 保存），坐标夹取在主屏内
  const onAdjustBarMouseDown = async (e: React.MouseEvent) => {
    if (!adjusting) return;
    e.preventDefault();
    const win = winRef.current;
    if (!win) return;
    const startMouse = { x: e.clientX, y: e.clientY };
    const startPos = await win.outerPosition();
    const mon = await primaryMonitor();

    const onMove = async (ev: MouseEvent) => {
      let nx = startPos.x + (ev.clientX - startMouse.x);
      let ny = startPos.y + (ev.clientY - startMouse.y);
      if (mon) {
        const dpr = window.devicePixelRatio || 1;
        const w = Math.round(BASE_WIDTH * scaleRef.current * dpr);
        const h = Math.round(BASE_HEIGHT * scaleRef.current * dpr);
        nx = Math.min(Math.max(nx, mon.position.x), mon.position.x + Math.max(mon.size.width - w, 0));
        ny = Math.min(Math.max(ny, mon.position.y), mon.position.y + Math.max(mon.size.height - h, 0));
      }
      await win.setPosition(new PhysicalPosition(nx, ny));
      lastPos.current = { x: nx, y: ny };
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <div className={`overlay-root ${adjusting ? 'adjusting' : ''} ${fading ? 'fading' : ''}`} style={{ zoom: config.scale }} onWheel={onWheel}>
      {adjusting && (
        <div className="adjust-bar" onMouseDown={onAdjustBarMouseDown}>
          <span className="adjust-hint">拖拽移动 · 滚轮缩放</span>
          <button
            className="adjust-done"
            onClick={() => {
              const win = winRef.current;
              if (win) void win.setIgnoreCursorEvents(true);
              setAdjusting(false);
              adjustingRef.current = false;
              void win?.outerPosition().then((pos) => {
                lastPos.current = { x: pos.x, y: pos.y };
                void emit('overlay:adjust-done', { position: lastPos.current, scale: Math.round(scaleRef.current * 100) / 100 });
              });
              void win?.hide();
            }}
          >
            完成 ✓
          </button>
        </div>
      )}
      {previewing && items.length === 0 && !adjusting && (
        <div className="overlay-preview">消息将显示在这里</div>
      )}
      {items.length > 0 && !adjusting && (
        <>
          {items.map((m) => (
            <div key={m.id} className="overlay-item">
              <MiniAvatar name={m.username} url={m.avatarUrl} />
              <span className="overlay-name">{m.username}</span>
              <span className="overlay-text">{m.text}</span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<OverlayApp />);
