import { useEffect, useRef, useState } from 'react';
import { useChat } from './stores/chat';
import { useAuth } from './stores/auth';
import { useSettings } from './app/settings';

function Avatar({ name, url, size = 28 }: { name: string; url?: string | null; size?: number }) {
  if (url) {
    return (
      <img
        className="avatar-img"
        src={url}
        alt={name}
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

function LoginView() {
  const { login, register, busy, error, clearError } = useAuth();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) return;
    clearError();
    try {
      if (mode === 'login') await login(username.trim(), password);
      else await register(username.trim(), password);
    } catch {
      // 错误信息已在 store 中展示
    }
  };

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-brand">
          <span className="logo big">GT</span>
          <h1>GameTalk</h1>
          <p>游戏玩家的轻量群组通信</p>
        </div>

        <div className="auth-tabs">
          <button type="button" className={`tab ${mode === 'login' ? 'active' : ''}`} onClick={() => setMode('login')}>
            登录
          </button>
          <button type="button" className={`tab ${mode === 'register' ? 'active' : ''}`} onClick={() => setMode('register')}>
            注册
          </button>
        </div>

        <label className="field">
          <span>用户名</span>
          <input
            value={username}
            autoFocus
            maxLength={24}
            placeholder="3-24 位字母/数字/中文"
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>
        <label className="field">
          <span>密码</span>
          <input
            type="password"
            value={password}
            maxLength={72}
            placeholder={mode === 'register' ? '至少 8 位' : '输入密码'}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>

        {error && (
          <div className="auth-error" role="alert">
            {error}
          </div>
        )}

        <button className="btn primary block" type="submit" disabled={busy || !username.trim() || password.length < (mode === 'register' ? 8 : 1)}>
          {busy ? '请稍候…' : mode === 'login' ? '登录' : '创建账号'}
        </button>
      </form>
    </div>
  );
}

function ChatView() {
  const { status, me, roomId, members, messages, connect, disconnect, sendMessage } = useChat();
  const { user, logout } = useAuth();
  const { soundEnabled, setSoundEnabled } = useSettings();
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const connected = status === 'open';

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages.length]);

  // 进入聊天视图自动连接
  useEffect(() => {
    if (status === 'idle') connect();
    return () => disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="logo">GT</span>
          <span className="brand-name">GameTalk</span>
        </div>
        <nav className="rooms">
          <div className="room-item active">
            <span className="hash">#</span>
            <span>lobby</span>
          </div>
        </nav>
        <div className="sidebar-footer user-block">
          <Avatar name={user?.username ?? ''} url={user?.avatarUrl} size={32} />
          <div className="user-info">
            <div className="user-name">{user?.username}</div>
            <div className="user-id">#{user?.id.slice(0, 8)}</div>
          </div>
          <button className="btn ghost small" title="退出登录" onClick={logout}>
            退出
          </button>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="topbar-title">
            <span className="hash">#</span>
            <span>{roomId ?? '…'}</span>
            {me && <span className="me-tag">{me.username}</span>}
          </div>
          <div className="topbar-right">
            <label className="sound-toggle" title="消息提示音">
              <input type="checkbox" checked={soundEnabled} onChange={(e) => setSoundEnabled(e.target.checked)} />
              声音
            </label>
            <span className="member-count">{members.length} 人在线</span>
            <StatusDot status={status} />
            <button className="btn ghost small" onClick={connected ? disconnect : connect}>
              {connected ? '断开' : '连接'}
            </button>
          </div>
        </header>

        <div className="messages" ref={listRef}>
          {messages.length === 0 && (
            <div className="empty">
              <p className="empty-title">欢迎来到 #lobby</p>
              <p className="empty-sub">发送第一条消息，开始与房间里的玩家实时沟通。</p>
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

export default function App() {
  const { token, user, refreshMe } = useAuth();

  // 启动时校验持久化的 token
  useEffect(() => {
    if (token && !user) void refreshMe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!token || !user) return <LoginView />;
  return <ChatView />;
}
