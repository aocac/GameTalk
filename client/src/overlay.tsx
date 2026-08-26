import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import './overlay.css';
import type { ChatMessage } from './app/types';

interface OverlayConfig {
  scale: number;
  durationSec: number;
}

const DEFAULT_CONFIG: OverlayConfig = { scale: 1, durationSec: 6 };
const MAX_ITEMS = 5;

function OverlayApp() {
  const [items, setItems] = useState<ChatMessage[]>([]);
  const [config, setConfig] = useState<OverlayConfig>(DEFAULT_CONFIG);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const configRef = useRef(config);
  configRef.current = config;

  // 点击穿透 + 永不聚焦：消息 Overlay 不干扰游戏操作
  useEffect(() => {
    const win = getCurrentWindow();
    void win.setIgnoreCursorEvents(true);
  }, []);

  useEffect(() => {
    let unlistenAppend: UnlistenFn | undefined;
    let unlistenConfig: UnlistenFn | undefined;
    let cancelled = false;

    void listen<ChatMessage>('overlay:append', (e) => {
      if (cancelled) return;
      setItems((prev) => [...prev, e.payload].slice(-MAX_ITEMS));
      scheduleShow();
    }).then((off) => (unlistenAppend = off));

    void listen<OverlayConfig>('overlay:config', (e) => {
      if (cancelled) return;
      setConfig((prev) => ({ ...prev, ...e.payload }));
      scheduleShow();
    }).then((off) => (unlistenConfig = off));

    return () => {
      cancelled = true;
      unlistenAppend?.();
      unlistenConfig?.();
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const scheduleShow = () => {
    const win = getCurrentWindow();
    void win.show();
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      void win.hide();
    }, configRef.current.durationSec * 1000);
  };

  return (
    <div className="overlay-root" style={{ zoom: config.scale }}>
      {items.length === 0 && <div className="overlay-empty" />}
      {items.map((m) => (
        <div key={m.id} className="overlay-item">
          <span className="overlay-name">{m.username}</span>
          <span className="overlay-text">{m.text}</span>
        </div>
      ))}
    </div>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<OverlayApp />);
