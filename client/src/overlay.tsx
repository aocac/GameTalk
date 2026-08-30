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

/** 若窗口位于主屏可视范围外，将其夹回屏内（防止拖出屏幕后找不到） */
async function pullIntoView(
  win: ReturnType<typeof getCurrentWindow>,
  scale: number,
): Promise<void> {
  const [pos, mon, dpr] = await Promise.all([
    win.outerPosition(),
    primaryMonitor(),
    Promise.resolve((typeof window !== 'undefined' && window.devicePixelRatio) || 1),
  ]);
  if (!mon) return;
  const w = Math.round(BASE_WIDTH * scale * dpr);
  const h = Math.round(BASE_HEIGHT * scale * dpr);
  const x0 = mon.position.x;
  const y0 = mon.position.y;
  const maxX = x0 + Math.max(mon.size.width - w, 0);
  const maxY = y0 + Math.max(mon.size.height - h, 0);
  // 容差 40px：窗口边缘略微出屏不强制拉回
  const visible = pos.x >= x0 - 40 && pos.y >= y0 - 40 && pos.x <= maxX + 40 && pos.y <= maxY + 40;
  if (!visible) {
    const nx = Math.min(Math.max(pos.x, x0), maxX);
    const ny = Math.min(Math.max(pos.y, y0), maxY);
    await win.setPosition(new PhysicalPosition(nx, ny));
  }
}

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

/** Overlay 消息条目：多房间订阅附带来源房间名；isSelf 标记自己发送（显示为"我"） */
type OverlayItem = ChatMessage & { roomName?: string; isSelf?: boolean };

function OverlayApp() {
  const [items, setItems] = useState<OverlayItem[]>([]);
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
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const winRef = useRef<ReturnType<typeof getCurrentWindow> | null>(null);

  // 调整模式下每 200ms 把窗口夹回主屏内（OS 拖拽可拖出屏幕，需要主动拉回）
  const startClampPoll = () => {
    if (pollRef.current) return;
    pollRef.current = setInterval(() => {
      const win = winRef.current;
      if (win && adjustingRef.current) void pullIntoView(win, scaleRef.current);
    }, 200);
  };
  const stopClampPoll = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
  };

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

  const scheduleHide = (durMsOverride?: number) => {
    clearTimers();
    const durMs = durMsOverride ?? configRef.current.durationSec * 1000;
      fadeTimer.current = setTimeout(() => {
        setFading(true);
        hideTimer.current = setTimeout(() => {
          const win = winRef.current;
          if (win) {
            // 预览/消息结束后恢复点击穿透（预览期间为了可拖拽暂时关闭）
            void win.setIgnoreCursorEvents(true);
            void win.hide();
          }
          setFading(false);
          setPreviewing(false);
          setItems([]);
        }, FADE_MS);
      }, Math.max(durMs - FADE_MS, 100));
  };

  // 预览框拖拽：OS 级 startDragging 绝对跟手；通过轮询位置稳定检测拖拽结束，
  // 结束后保存为自定义位置（主窗口监听 adjust-done 会自动切换 overlayPosition 为 custom）
  const onPreviewDragStart = (e: React.MouseEvent) => {
    e.preventDefault();
    const win = winRef.current;
    if (!win) return;
    clearTimers(); // 拖拽期间不自动隐藏
    setFading(false);
    void win.startDragging();
    void (async () => {
      let last = await win.outerPosition();
      let stable = 0;
      const t0 = Date.now();
      const iv = setInterval(async () => {
        try {
          const now = await win.outerPosition();
          if (Math.abs(now.x - last.x) < 3 && Math.abs(now.y - last.y) < 3) stable++;
          else stable = 0;
          last = now;
          // 位置连续 ~300ms 不变视为拖拽结束
          if (stable >= 2 || Date.now() - t0 > 15000) {
            clearInterval(iv);
            const pos = { x: Math.round(now.x), y: Math.round(now.y) };
            lastPos.current = pos;
            void emit('overlay:adjust-done', {
              position: pos,
              scale: Math.round(scaleRef.current * 100) / 100,
            });
            // 保持预览 5 秒，让用户确认新位置（主窗口侧会把位置夹回屏内并切换为 custom）
            scheduleHide(5000);
          }
        } catch {
          clearInterval(iv);
        }
      }, 150);
    })();
  };

  useEffect(() => {
    let unlistenAppend: UnlistenFn | undefined;
    let unlistenConfig: UnlistenFn | undefined;
    let unlistenAdjust: UnlistenFn | undefined;
    let unlistenPreview: UnlistenFn | undefined;
    let unlistenHide: UnlistenFn | undefined;
    const unlistenersEdit: UnlistenFn[] = [];
    const unlistenersRecall: UnlistenFn[] = [];
    let cancelled = false;

    void listen<OverlayItem>('overlay:append', (e) => {
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
          stopClampPoll();
          void win.setIgnoreCursorEvents(true);
        }
        // 消息始终点击穿透（预览期间可能被关掉了）
        void win.setIgnoreCursorEvents(true);
        // 窗口若在屏幕外（曾被拖出）则先拉回
        void pullIntoView(win, scaleRef.current).then(() => void win.show());
      }
      scheduleHide();
    }).then((off) => (unlistenAppend = off));

    void listen<OverlayConfig>('overlay:config', (e) => {
      if (cancelled) return;
      setConfig((prev) => ({ ...prev, ...e.payload }));
      scaleRef.current = e.payload.scale ?? scaleRef.current;
    }).then((off) => (unlistenConfig = off));

    // 位置预览：设置里调整位置/大小后显示 5 秒确认效果（Overlay 平时隐藏）
    void listen('overlay:preview', () => {
      if (cancelled) return;
      const win = winRef.current;
      if (!win) return;
      setFading(false);
      setPreviewing(true);
      if (adjustingRef.current) {
        setAdjusting(false);
        adjustingRef.current = false;
        stopClampPoll();
        void win.setIgnoreCursorEvents(true);
      }
      // show 在 preview 监听内执行：与 adjust 退出的 hide 同源（同一 webview）同序，
      // 保证先 hide 后 show，窗口最终可见——消除跨 webview 的 hide/show 竞态
      // 强制置顶（防御：alwaysOnTop 配置失效时防止被主窗口遮挡）
      void win.setAlwaysOnTop(true);
      // 预览期间允许鼠标交互（可点击预览框上的「拖动」按钮）
      void win.setIgnoreCursorEvents(false);
      void win.show();
      scheduleHide(5000);
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
        // 进入调整模式：若窗口在屏幕外（上次拖出），拉回屏内；并启动防出屏轮询
        void pullIntoView(win, scaleRef.current).then(() => void win.show());
        startClampPoll();
      } else {
        // 外部退出（如设置里复位/切预设）：不保存位置、不 emit adjust-done，
        // 避免回调覆盖用户当前选择的位置（竞态根因）
        stopClampPoll();
        void win.hide();
      }
    }).then((off) => (unlistenAdjust = off));

    // 消息编辑/撤回同步（覆盖层正挂着该消息时即时更新/移除）
    void listen<{ messageId: string; text: string }>('overlay:edit', (e) => {
      if (cancelled) return;
      setItems((prev) =>
        prev.map((m) => (m.id === e.payload.messageId ? { ...m, text: e.payload.text, editedAt: new Date().toISOString() } : m)),
      );
    }).then((off) => unlistenersEdit.push(off));
    void listen<{ messageId: string }>('overlay:recalled', (e) => {
      if (cancelled) return;
      setItems((prev) => prev.filter((m) => m.id !== e.payload.messageId));
    }).then((off) => unlistenersRecall.push(off));

    // 立即隐藏（设置窗口关闭时收起预览，不等自然超时）
    void listen('overlay:hide', () => {
      if (cancelled) return;
      clearTimers();
      setFading(false);
      setPreviewing(false);
      setItems([]);
      const win = winRef.current;
      if (win) void win.hide();
    }).then((off) => (unlistenHide = off));

    return () => {
      cancelled = true;
      unlistenAppend?.();
      unlistenConfig?.();
      unlistenAdjust?.();
      unlistenPreview?.();
      unlistenHide?.();
      for (const off of [...unlistenersEdit, ...unlistenersRecall]) off();
      stopClampPoll();
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
    // 同步更新 transform 缩放（窗口尺寸 setSize 与内容 transform 匹配）
    setConfig((prev) => ({ ...prev, scale: next }));
    void win.setSize(new PhysicalSize(Math.round(BASE_WIDTH * next * dpr), Math.round(BASE_HEIGHT * next * dpr)));
  };

  // 调整模式：OS 级拖拽（startDragging 绝对跟手）；最终位置在完成时读取
  const onAdjustBarMouseDown = (e: React.MouseEvent) => {
    if (!adjusting) return;
    // 关键：点击「完成」按钮时不触发拖拽——否则 mousedown 先开始拖窗，
    // click 事件被系统拖拽吞掉，导致完成按钮永远点不生效
    if ((e.target as HTMLElement).closest('.adjust-done')) return;
    e.preventDefault();
    const win = winRef.current;
    if (win) void win.startDragging();
  };

  return (
    <div
      className={`overlay-root ${adjusting ? 'adjusting' : ''} ${fading ? 'fading' : ''}`}
      // 内容缩放用 transform（不影响布局尺寸），窗口 setSize 已按 scale 放大，
      // 两者匹配避免 zoom 造成的"平方放大"视觉偏移
      style={{ transform: `scale(${config.scale})`, width: BASE_WIDTH, height: BASE_HEIGHT }}
      onWheel={onWheel}
    >
      {adjusting && (
        <div className="adjust-bar" onMouseDown={onAdjustBarMouseDown}>
          <span className="adjust-hint">拖拽移动 · 滚轮缩放</span>
          <button
            className="adjust-done"
            onClick={() => {
              const win = winRef.current;
              stopClampPoll();
              if (win) void win.setIgnoreCursorEvents(true);
              setAdjusting(false);
              adjustingRef.current = false;
              // 完成：读取最终位置（夹回屏内后）保存，然后隐藏（不再触发预览重新显示）
              void (async () => {
                if (!win) return;
                const pos = await win.outerPosition();
                const mon = await primaryMonitor();
                let x = pos.x;
                let y = pos.y;
                if (mon) {
                  const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
                  const w = Math.round(BASE_WIDTH * scaleRef.current * dpr);
                  const h = Math.round(BASE_HEIGHT * scaleRef.current * dpr);
                  x = Math.min(Math.max(x, mon.position.x), mon.position.x + Math.max(mon.size.width - w, 0));
                  y = Math.min(Math.max(y, mon.position.y), mon.position.y + Math.max(mon.size.height - h, 0));
                  if (x !== pos.x || y !== pos.y) await win.setPosition(new PhysicalPosition(x, y));
                }
                lastPos.current = { x, y };
                void emit('overlay:adjust-done', { position: lastPos.current, scale: Math.round(scaleRef.current * 100) / 100 });
                void win.hide();
              })();
            }}
          >
            完成 ✓
          </button>
        </div>
      )}
      {previewing && items.length === 0 && !adjusting && (
        <div className="overlay-preview">
          <span className="overlay-preview-text">消息将显示在这里</span>
          <button
            className="overlay-drag-btn"
            onMouseDown={onPreviewDragStart}
            title="拖动预览框到新位置，将自动切换为「自定义」位置"
          >
            ✥ 拖动
          </button>
        </div>
      )}
      {items.length > 0 && !adjusting && (
        <>
          {items.map((m) => (
            <div key={m.id} className={`overlay-item ${m.isSelf ? 'self' : ''}`}>
              <MiniAvatar name={m.username} url={m.avatarUrl} />
              <span className="overlay-name">{m.isSelf ? '我' : m.username}</span>
              {m.roomName && <span className="overlay-room">#{m.roomName}</span>}
              {/* 图文消息 = [图片]/[表情] 前缀 + 文字；纯图 = 占位 */}
              <span className="overlay-text">
                {m.kind === 'sticker' ? '[表情]' : m.kind === 'image' ? '[图片]' : ''}
                {m.text}
              </span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<OverlayApp />);
