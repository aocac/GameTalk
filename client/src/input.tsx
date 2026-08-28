import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { emit } from '@tauri-apps/api/event';
import './input.css';

function InputApp() {
  const [text, setText] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  const gotFocus = useRef(false);

  useEffect(() => {
    // 窗口显示后聚焦输入框
    const t = setTimeout(() => ref.current?.focus(), 120);
    // 失焦（点击输入框外的游戏/桌面）= 放弃输入，自动关闭（等同 Esc 取消）
    // 首次聚焦前的初始失焦事件需忽略，避免一呼出就被误关
    let off: (() => void) | undefined;
    void getCurrentWindow()
      .onFocusChanged(({ payload }) => {
        if (payload) {
          gotFocus.current = true;
        } else if (gotFocus.current) {
          void emit('game-input-cancel');
        }
      })
      .then((fn) => (off = fn));
    return () => {
      clearTimeout(t);
      off?.();
    };
  }, []);

  const send = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    void emit('game-input-send', trimmed);
    setText('');
  };

  return (
    <div className="input-shell">
      <span className="input-prefix">#</span>
      <input
        ref={ref}
        className="input-box"
        value={text}
        maxLength={2000}
        placeholder="输入消息，Enter 发送，Esc 取消"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // 中文输入法组词期间的 Enter/Esc 是输入法操作，不是发送/取消
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === 'Enter') {
            e.preventDefault();
            send();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            void emit('game-input-cancel');
          }
        }}
      />
      <span className="input-hint">Enter ↵</span>
    </div>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<InputApp />);
