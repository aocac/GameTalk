import { useEffect, useRef, useState } from 'react';
import { useChat } from './stores/chat';
import { useSettings } from './app/settings';

function Avatar({ name, size = 28 }: { name: string; size?: number }) {
  const initials = (name || '?').slice(0, 2).toUpperCase();
  const hue = [...(name || '')].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  return (
    <span
      className="avatar"
      style={{ width: size, height: size, background: `hsl(${hue} 60% 82%)`, color: `hsl(${hue} 45% 28%)`, fontSize: size * 0.38 }}
    >
      {initials}
    </span>
  );
}

function StatusDot({ status }: { status: string }) {
  const map: Record<string, { cls: string; label: string }> = {
    open: { cls: 'ok', label: '已连接' },
    connecting: { cls: 'pending', label: '连接中…' },
    reconnecting: { cls: 'pending', label: '重连中…' },
    closed: { cls: 'off', label: '已断开' },
    idle: { cls: 'off', label: '未连接' },
  };
  const s = map[status] ?? map.idle;
  return (
    <span className="status" title={s.label}>
      <span className={`dot ${s.cls}`} />
      {s.label}
    </span>
  );
}

export default function App() {
  const { status, me, roomId, members, messages, connect, disconnect, sendMessage } = useChat();
  const { quickName, setQuickName, soundEnabled, setSoundEnabled } = useSettings();
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages.length]);

  const connected = status === 'open';

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="logo">GT</span>
          <span className="brand-name">GameTalk</span>
        </div>
        <div className="sidebar-user">
          <input
            className="name-input"
            value={quickName}
            placeholder="你的昵称"
            maxLength={32}
            disabled={connected}
            onChange={(e) => setQuickName(e.target.value)}
          />
        </div>
        <nav className="rooms">
          <div className="room-item active">
            <span className="hash">#</span>
            <span>lobby</span>
          </div>
        </nav>
        <div className="sidebar-footer">
          <StatusDot status={status} />
          <button
            className="btn ghost small"
            onClick={connected ? disconnect : connect}
            disabled={!connected && !quickName.trim()}
          >
            {connected ? '断开' : '连接'}
          </button>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="topbar-title">
            <span className="hash">#</span>
            <span>{roomId ?? '…'}</span>
            {me && <span className="me-tag">作为 {me.username}</span>}
          </div>
          <div className="topbar-right">
            <label className="sound-toggle" title="消息提示音">
              <input type="checkbox" checked={soundEnabled} onChange={(e) => setSoundEnabled(e.target.checked)} />
              声音
            </label>
            <span className="member-count">{members.length} 人在线</span>
          </div>
        </header>

        <div className="messages" ref={listRef}>
          {messages.length === 0 && (
            <div className="empty">
              <p className="empty-title">欢迎来到 #lobby</p>
              <p className="empty-sub">连接后发送第一条消息，看看实时通信是否工作。</p>
            </div>
          )}
          {messages.map((m) => (
            <div key={m.id} className={`message ${m.userId === me?.id ? 'mine' : ''}`}>
              <Avatar name={m.username} size={30} />
              <div className="message-body">
                <div className="message-head">
                  <span className="message-author">{m.username}</span>
                  <span className="message-time">{new Date(m.createdAt).toLocaleTimeString()}</span>
                </div>
                <div className="message-text">{m.text}</div>
              </div>
            </div>
          ))}
        </div>

        <footer className="composer">
          <input
            className="composer-input"
            value={draft}
            placeholder={connected ? '输入消息，Enter 发送' : '未连接'}
            disabled={!connected}
            maxLength={2000}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && connected) {
                e.preventDefault();
                if (draft.trim()) {
                  sendMessage(draft);
                  setDraft('');
                }
              }
            }}
          />
          <button
            className="btn primary"
            disabled={!connected || !draft.trim()}
            onClick={() => {
              sendMessage(draft);
              setDraft('');
            }}
          >
            发送
          </button>
        </footer>
      </main>
    </div>
  );
}
