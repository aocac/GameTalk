import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { getCurrentWindow, primaryMonitor } from '@tauri-apps/api/window';
import { PhysicalPosition, PhysicalSize } from '@tauri-apps/api/dpi';
import { emit, listen } from '@tauri-apps/api/event';
import './input.css';

// 游戏内输入框同样是桌面窗口：屏蔽网页右键菜单（输入框自身保留）
document.addEventListener('contextmenu', (e) => {
  const target = e.target as HTMLElement | null;
  if (!target?.closest('input, textarea')) e.preventDefault();
});

interface InputTarget {
  kind: 'room' | 'dm';
  id: string;
  name: string;
}

/** 输入框窗口常规/展开（选目标列表）高度；展开时底边保持不动 */
const SHORT_H = 64;
const TALL_H = 340;

async function resizeWindow(tall: boolean): Promise<void> {
  try {
    const win = getCurrentWindow();
    const mon = await primaryMonitor();
    if (!mon) return;
    const dpr = window.devicePixelRatio || 1;
    const pos = await win.outerPosition();
    const bottom = pos.y + SHORT_H * dpr;
    const h = tall ? TALL_H : SHORT_H;
    await win.setSize(new PhysicalSize(Math.round(460 * dpr), Math.round(h * dpr)));
    // 底边固定：向下展开列表而不是把输入条顶走
    await win.setPosition(new PhysicalPosition(pos.x, Math.round(bottom - h * dpr)));
  } catch {
    // 忽略窗口操作失败（列表仍可用，只是可能被裁剪）
  }
}

function InputApp() {
  const [text, setText] = useState('');
  /** 当前目标 + 全部可选目标（主窗口下发） */
  const [current, setCurrent] = useState<InputTarget | null>(null);
  const [targets, setTargets] = useState<InputTarget[]>([]);
  const [showList, setShowList] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const gotFocus = useRef(false);

  useEffect(() => {
    const offCtx = listen<{ current: InputTarget | null; targets: InputTarget[] }>('game-input-context', (e) => {
      setCurrent(e.payload?.current ?? null);
      setTargets(e.payload?.targets ?? []);
    });
    return () => {
      void offCtx.then((fn) => fn());
    };
  }, []);

  const toggleList = (open: boolean) => {
    setShowList(open);
    void resizeWindow(open);
  };

  const pickTarget = (t: InputTarget) => {
    setCurrent(t);
    toggleList(false);
    // 主窗口切换会话（后续发送走该目标）并回发上下文
    void emit('game-input-select', { kind: t.kind, id: t.id });
    ref.current?.focus();
  };

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
    <div className="input-page">
      {showList && (
        <div className="target-list">
          <div className="target-list-title">发送到…（点击切换）</div>
          {targets.length === 0 && <div className="target-empty">暂无房间或好友</div>}
          {targets.map((t) => (
            <button
              key={`${t.kind}-${t.id}`}
              type="button"
              className={`target-item ${current?.kind === t.kind && current?.id === t.id ? 'active' : ''}`}
              onClick={() => pickTarget(t)}
            >
              <span className="target-kind">{t.kind === 'dm' ? '@' : '#'}</span>
              {t.name}
            </button>
          ))}
        </div>
      )}
      <div className="input-shell">
        <button className="input-target" title="点击选择发送目标" onClick={() => toggleList(!showList)}>
          <span className="input-target-prefix">{current?.kind === 'dm' ? '@' : '#'}</span>
          <span className="input-target-name">{current?.name ?? '未选择'}</span>
          <span className="input-target-caret">▾</span>
        </button>
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
              if (showList) {
                toggleList(false);
              } else {
                void emit('game-input-cancel');
              }
            }
          }}
        />
        <button className="input-send" disabled={!text.trim()} onClick={send}>
          发送
        </button>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<InputApp />);
