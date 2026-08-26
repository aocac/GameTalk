import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { emit } from '@tauri-apps/api/event';
import './input.css';

function InputApp() {
  const [text, setText] = useState('');
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // 窗口显示后聚焦输入框
    const t = setTimeout(() => ref.current?.focus(), 120);
    return () => clearTimeout(t);
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
