import { useEffect, useRef, useState } from 'react';
import { useChat } from './stores/chat';
import { useAuth } from './stores/auth';
import { useSettings, DEFAULT_HOTKEY, type OverlayPosition } from './app/settings';
import * as gameMode from './app/gameMode';

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

const POSITION_LABELS: Record<OverlayPosition, string> = {
  'top-left': '左上',
  'top-center': '顶部居中',
  'top-right': '右上',
  'bottom-left': '左下',
  'bottom-center': '底部居中',
  'bottom-right': '右下',
};

function SettingsModal({ onClose }: { onClose: () => void }) {
  const {
    serverUrl,
    setServerUrl,
    soundEnabled,
    setSoundEnabled,
    gameModeEnabled,
    setGameModeEnabled,
    hotkey,
    setHotkey,
    overlayPosition,
    setOverlayPosition,
    overlayScale,
    setOverlayScale,
    overlayDurationSec,
    setOverlayDurationSec,
  } = useSettings();
  const { user, updateProfile, busy } = useAuth();
  const [username, setUsername] = useState(user?.username ?? '');
  const [avatarUrl, setAvatarUrl] = useState(user?.avatarUrl ?? '');
  const [profileMsg, setProfileMsg] = useState<string | null>(null);

  const saveProfile = async () => {
    setProfileMsg(null);
    try {
      await updateProfile({ username: username.trim() || user?.username, avatarUrl });
      setProfileMsg('已保存');
    } catch {
      setProfileMsg(null);
    }
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <h3>设置</h3>

        <div className="settings-section">
          <span className="section-title">个人资料</span>
          <div className="profile-row">
            <Avatar name={username || user?.username || ''} url={avatarUrl} size={44} />
            <div className="user-info">
              <div className="user-name">{user?.username}</div>
              <div className="user-id">#{user?.id.slice(0, 8)}</div>
            </div>
          </div>
          <label className="field">
            <span>昵称</span>
            <input value={username} maxLength={24} onChange={(e) => setUsername(e.target.value)} />
          </label>
          <label className="field">
            <span>头像 URL（可选，留空使用首字母头像）</span>
            <input
              value={avatarUrl}
              placeholder="https://example.com/avatar.png"
              onChange={(e) => setAvatarUrl(e.target.value)}
            />
          </label>
          <div className="row-between">
            <button className="btn primary small" disabled={busy} onClick={() => void saveProfile()}>
              {busy ? '保存中…' : '保存资料'}
            </button>
            {profileMsg && <span className="ok-text">{profileMsg}</span>}
          </div>
        </div>

        <label className="field">
          <span>服务器地址</span>
          <input value={serverUrl} placeholder="http://127.0.0.1:8787" onChange={(e) => setServerUrl(e.target.value)} />
        </label>

        <label className="field">
          <span>消息提示音</span>
          <div className="switch-row">
            <input type="checkbox" checked={soundEnabled} onChange={(e) => setSoundEnabled(e.target.checked)} />
            {soundEnabled ? '已开启' : '已关闭'}
          </div>
        </label>

        <div className="settings-section">
          <span className="section-title">游戏模式</span>
          <label className="field">
            <span>启用游戏模式（全局快捷键 + Overlay）</span>
            <div className="switch-row">
              <input type="checkbox" checked={gameModeEnabled} onChange={(e) => setGameModeEnabled(e.target.checked)} />
              {gameModeEnabled ? '已启用' : '已停用'}
            </div>
          </label>
          <label className="field">
            <span>呼出快捷键</span>
            <input value={hotkey} placeholder={DEFAULT_HOTKEY} onChange={(e) => setHotkey(e.target.value)} />
          </label>
        </div>

        <div className="settings-section">
          <span className="section-title">消息 Overlay</span>
          <label className="field">
            <span>显示位置</span>
            <select value={overlayPosition} onChange={(e) => setOverlayPosition(e.target.value as OverlayPosition)}>
              {Object.entries(POSITION_LABELS).map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>缩放比例：{Math.round(overlayScale * 100)}%</span>
            <input
              type="range"
              min={0.5}
              max={2}
              step={0.1}
              value={overlayScale}
              onChange={(e) => setOverlayScale(parseFloat(e.target.value))}
            />
          </label>
          <label className="field">
            <span>显示时长：{overlayDurationSec} 秒</span>
            <input
              type="range"
              min={2}
              max={15}
              step={1}
              value={overlayDurationSec}
              onChange={(e) => setOverlayDurationSec(parseInt(e.target.value, 10))}
            />
          </label>
        </div>

        <button className="btn primary block" onClick={onClose}>
          完成
        </button>
      </div>
    </div>
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
  const {
    status,
    me,
    rooms,
    activeRoomId,
    membersByRoom,
    messagesByRoom,
    loadingRooms,
    roomError,
    connect,
    disconnect,
    createRoom,
    joinRoomByCode,
    selectRoom,
    leaveActiveRoom,
    sendMessage,
    clearRoomError,
  } = useChat();
  const { user, logout } = useAuth();
  const { soundEnabled, setSoundEnabled } = useSettings();
  const [draft, setDraft] = useState('');
  const [showRoomModal, setShowRoomModal] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [roomName, setRoomName] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const connected = status === 'open';
  const activeRoom = rooms.find((r) => r.id === activeRoomId) ?? null;
  const messages = activeRoomId ? (messagesByRoom[activeRoomId] ?? []) : [];
  const members = activeRoomId ? (membersByRoom[activeRoomId] ?? []) : [];

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages.length]);

  // 进入聊天视图自动连接（connect 幂等，StrictMode 双挂载安全）
  useEffect(() => {
    connect();
    return () => disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 游戏模式生命周期：启停快捷键 + Overlay 事件监听
  const { gameModeEnabled, overlayPosition, overlayScale, overlayDurationSec } = useSettings();
  useEffect(() => {
    gameMode.setOnSend((text) => {
      useChat.getState().sendMessage(text);
    });
    if (gameModeEnabled) {
      void gameMode.startGameMode();
    } else {
      void gameMode.stopGameMode();
    }
    return () => {
      if (gameModeEnabled) void gameMode.stopGameMode();
    };
  }, [gameModeEnabled]);

  // Overlay 位置/缩放/时长变化时立即生效
  useEffect(() => {
    if (gameModeEnabled) void gameMode.applyOverlayConfig();
  }, [gameModeEnabled, overlayPosition, overlayScale, overlayDurationSec]);

  const submitRoomModal = async (kind: 'create' | 'join') => {
    if (kind === 'create') {
      if (!roomName.trim()) return;
      const room = await createRoom(roomName.trim());
      if (room) setShowRoomModal(false);
    } else {
      if (!inviteCode.trim()) return;
      const room = await joinRoomByCode(inviteCode.trim().toUpperCase());
      if (room) setShowRoomModal(false);
    }
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="logo">GT</span>
          <span className="brand-name">GameTalk</span>
        </div>
        <div className="rooms-header">
          <span>房间</span>
          <button className="icon-btn" title="创建/加入房间" onClick={() => setShowRoomModal(true)}>
            +
          </button>
        </div>
        <nav className="rooms">
          {loadingRooms && rooms.length === 0 && <div className="rooms-hint">加载中…</div>}
          {!loadingRooms && rooms.length === 0 && (
            <div className="rooms-hint">
              还没有房间
              <br />
              点击 + 创建或加入
            </div>
          )}
          {rooms.map((r) => (
            <div
              key={r.id}
              className={`room-item ${r.id === activeRoomId ? 'active' : ''}`}
              onClick={() => void selectRoom(r.id)}
              title={r.inviteCode}
            >
              <span className="hash">#</span>
              <span className="room-name">{r.name}</span>
              <span className="room-count">{r.memberCount}</span>
            </div>
          ))}
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
            <span>{activeRoom?.name ?? '未选择房间'}</span>
            {activeRoom && <span className="me-tag">邀请码 {activeRoom.inviteCode}</span>}
          </div>
          <div className="topbar-right">
            {gameModeEnabled && <span className="game-mode-tag">游戏模式</span>}
            <label className="sound-toggle" title="消息提示音">
              <input type="checkbox" checked={soundEnabled} onChange={(e) => setSoundEnabled(e.target.checked)} />
              声音
            </label>
            <span className="member-count">{members.length} 人在线</span>
            <StatusDot status={status} />
            <button className="btn ghost small" onClick={connected ? disconnect : connect}>
              {connected ? '断开' : '连接'}
            </button>
            <button className="btn ghost small" onClick={() => setShowSettings(true)}>
              设置
            </button>
          </div>
        </header>

        {roomError && (
          <div className="banner-error">
            <span>{roomError}</span>
            <button className="btn ghost small" onClick={clearRoomError}>
              关闭
            </button>
          </div>
        )}

        <div className="messages" ref={listRef}>
          {!activeRoom && (
            <div className="empty">
              <p className="empty-title">选择一个房间</p>
              <p className="empty-sub">创建新房间或通过邀请码加入，开始实时沟通。</p>
              <button className="btn primary" style={{ marginTop: 14 }} onClick={() => setShowRoomModal(true)}>
                创建 / 加入房间
              </button>
            </div>
          )}
          {activeRoom && messages.length === 0 && (
            <div className="empty">
              <p className="empty-title">欢迎来到 #{activeRoom.name}</p>
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
            placeholder={connected ? (activeRoom ? '输入消息，Enter 发送' : '先选择或创建房间') : '未连接'}
            disabled={!connected || !activeRoom}
            maxLength={2000}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && connected && activeRoom) {
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
            disabled={!connected || !activeRoom || !draft.trim()}
            onClick={() => {
              sendMessage(draft);
              setDraft('');
            }}
          >
            发送
          </button>
          {activeRoom && (
            <button className="btn ghost" title="离开房间" onClick={() => void leaveActiveRoom()}>
              离开
            </button>
          )}
        </footer>
      </main>

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}

      {showRoomModal && (
        <div className="modal-mask" onClick={() => setShowRoomModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>创建 / 加入房间</h3>
            <label className="field">
              <span>创建房间（输入名称）</span>
              <input
                value={roomName}
                maxLength={40}
                placeholder="例如：开黑小队"
                onChange={(e) => setRoomName(e.target.value)}
              />
            </label>
            <button
              className="btn primary block"
              disabled={!roomName.trim()}
              onClick={() => void submitRoomModal('create')}
            >
              创建
            </button>
            <div className="modal-divider">或</div>
            <label className="field">
              <span>加入房间（输入邀请码）</span>
              <input
                value={inviteCode}
                maxLength={8}
                placeholder="例如：AB12CD34"
                onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
              />
            </label>
            <button
              className="btn primary block"
              disabled={inviteCode.trim().length !== 8}
              onClick={() => void submitRoomModal('join')}
            >
              加入
            </button>
          </div>
        </div>
      )}
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
