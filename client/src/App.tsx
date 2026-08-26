import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useChat } from './stores/chat';
import { useAuth } from './stores/auth';
import { useSettings, type OverlayPosition } from './app/settings';
import * as gameMode from './app/gameMode';
import HotkeyRecorder from './components/HotkeyRecorder';

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
  custom: '自定义（拖拽）',
};

const MAX_AVATAR_BYTES = 512 * 1024;

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
    overlayCustomPosition,
    setOverlayCustomPosition,
    overlayScale,
    setOverlayScale,
    overlayDurationSec,
    setOverlayDurationSec,
  } = useSettings();
  const { user, updateProfile, uploadAvatar, busy } = useAuth();
  const [username, setUsername] = useState(user?.username ?? '');
  const [profileMsg, setProfileMsg] = useState<string | null>(null);
  const [avatarMsg, setAvatarMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // 位置/缩放变化后应用（不自动预览：避免 adjust-done 保存时窗口被重新显示）
  useEffect(() => {
    if (!gameModeEnabled) return;
    // 「自定义」且尚无保存过的自定义坐标：不跳位置（保持当前，等待用户拖拽）
    if (overlayPosition === 'custom' && overlayCustomPosition == null) return;
    void gameMode.applyOverlayConfig();
  }, [overlayPosition, overlayScale, overlayCustomPosition, gameModeEnabled]);

  // 用户主动调整位置/缩放后的 3 秒预览（让用户确认效果）
  const previewAfterApply = () => {
    void gameMode.applyOverlayConfig().then(() => void gameMode.previewOverlay());
  };

  const closeModal = () => {
    // 防止调整模式残留卡死
    void gameMode.stopOverlayAdjust();
    onClose();
  };

  const saveProfile = async () => {
    setProfileMsg(null);
    try {
      await updateProfile({ username: username.trim() || user?.username });
      setProfileMsg('已保存');
    } catch {
      setProfileMsg(null);
    }
  };

  const onAvatarFile = async (file: File | undefined) => {
    setAvatarMsg(null);
    if (!file) return;
    if (file.size > MAX_AVATAR_BYTES) {
      setAvatarMsg('图片需 ≤512KB，请换一张更小的图');
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = String(reader.result ?? '');
      try {
        await uploadAvatar(dataUrl);
        setAvatarMsg('头像已更新');
      } catch {
        setAvatarMsg('上传失败（仅支持 PNG/JPEG/WebP/GIF）');
      }
    };
    reader.readAsDataURL(file);
  };

  const onHotkeyChange = (v: string) => {
    setHotkey(v);
    if (gameModeEnabled) void gameMode.reapplyHotkey();
  };

  return (
    <div className="modal-mask" onClick={closeModal}>
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <h3>设置</h3>

        <div className="settings-section">
          <span className="section-title">个人资料</span>
          <div className="profile-row">
            <button className="avatar-btn" title="点击更换头像" onClick={() => fileRef.current?.click()}>
              <Avatar name={username || user?.username || ''} url={user?.avatarUrl} size={48} />
            </button>
            <div className="user-info">
              <div className="user-name">{user?.username}</div>
              <div className="user-id">#{user?.id.slice(0, 8)}</div>
              <button className="btn ghost small" onClick={() => fileRef.current?.click()}>
                {busy ? '上传中…' : '更换头像'}
              </button>
            </div>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            style={{ display: 'none' }}
            onChange={(e) => {
              void onAvatarFile(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
          {avatarMsg && <span className={avatarMsg.includes('失败') ? 'err-text' : 'ok-text'}>{avatarMsg}</span>}
          <label className="field">
            <span>昵称</span>
            <input value={username} maxLength={24} onChange={(e) => setUsername(e.target.value)} />
          </label>
          <div className="row-between">
            <button className="btn primary small" disabled={busy} onClick={() => void saveProfile()}>
              {busy ? '保存中…' : '保存昵称'}
            </button>
            {profileMsg && <span className="ok-text">{profileMsg}</span>}
          </div>
        </div>

        <label className="field">
          <span>服务器地址</span>
          <input
            value={serverUrl}
            placeholder="https://chat.example.com"
            onChange={(e) => setServerUrl(e.target.value)}
          />
          <span className="field-hint">填写你部署的 GameTalk 服务器地址（如 https://chat.example.com）；本地开发调试可用 http://127.0.0.1:8787</span>
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
            <span>呼出快捷键（点击后按下组合键）</span>
            <HotkeyRecorder value={hotkey} onChange={onHotkeyChange} />
          </label>
        </div>

        <div className="settings-section">
          <span className="section-title">消息 Overlay</span>
          <label className="field">
            <span>显示位置</span>
            <select
              value={overlayPosition}
              onChange={(e) => {
                const v = e.target.value as OverlayPosition;
                if (v === 'custom') {
                  // 选择「自定义」= 进入拖拽调整，保持当前位置，绝不跳位
                  setOverlayPosition(v);
                  void gameMode.stopOverlayAdjust();
                  void gameMode.startOverlayAdjust();
                } else {
                  setOverlayPosition(v);
                  if (gameModeEnabled) previewAfterApply();
                }
              }}
            >
              {Object.entries(POSITION_LABELS).map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <button
            className="btn ghost block"
            disabled={!gameModeEnabled}
            onClick={() => {
              // 先退出可能残留的调整态，再进入（不切换 preset，避免与预览竞争）
              void gameMode.stopOverlayAdjust();
              void gameMode.applyOverlayConfig().then(() => void gameMode.startOverlayAdjust());
            }}
          >
            {gameModeEnabled ? '拖拽调整 Overlay 位置/大小（在屏幕上直接拖动）' : '需先启用游戏模式'}
          </button>
          {gameModeEnabled && (
            <button
              className="btn ghost block"
              onClick={() => {
                void gameMode.stopOverlayAdjust();
                setOverlayCustomPosition(null);
                setOverlayPosition('top-left');
                previewAfterApply();
              }}
            >
              复位到左上角
            </button>
          )}
          <label className="field">
            <span>缩放比例：{Math.round(overlayScale * 100)}%</span>
            <input
              type="range"
              min={0.5}
              max={2}
              step={0.1}
              value={overlayScale}
              onChange={(e) => {
                setOverlayScale(parseFloat(e.target.value));
                if (gameModeEnabled) previewAfterApply();
              }}
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

        <button className="btn primary block" onClick={closeModal}>
          完成
        </button>
      </div>
    </div>
  );
}

function LoginView({ onOffline }: { onOffline: () => void }) {
  const { login, register, busy, error, clearError } = useAuth();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  // 未登录时也能配置服务器地址（否则连接失败时会陷入无法改地址的死锁）
  const { serverUrl, setServerUrl } = useSettings();
  const [showServer, setShowServer] = useState(false);
  const [serverDraft, setServerDraft] = useState(serverUrl);
  const [serverMsg, setServerMsg] = useState<string | null>(null);
  const serverMsgTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

        <button
          type="button"
          className="server-toggle"
          onClick={() => {
            if (!showServer) setServerDraft(useSettings.getState().serverUrl);
            setShowServer((v) => !v);
          }}
          title="配置要连接的服务器"
        >
          {serverMsg ? `已保存 ✓` : showServer ? '收起服务器设置' : `服务器：${serverUrl}`}
        </button>
        {showServer && (
          <div className="server-config">
            <label className="field">
              <span>服务器地址（连接你自己的 GameTalk 服务器）</span>
              <input
                value={serverDraft}
                onChange={(e) => setServerDraft(e.target.value)}
                placeholder="https://chat.example.com"
              />
            </label>
            <div className="row-between">
              <button
                type="button"
                className="btn primary small"
                onClick={() => {
                  setServerUrl(serverDraft.trim() || serverDraft);
                  setServerMsg('已保存');
                  if (serverMsgTimer.current) clearTimeout(serverMsgTimer.current);
                  serverMsgTimer.current = setTimeout(() => setServerMsg(null), 2000);
                  // 保存成功即收起编辑面板（回到简洁状态）
                  setShowServer(false);
                }}
              >
                保存
              </button>
              {serverMsg && <span className="ok-text">{serverMsg}</span>}
            </div>
          </div>
        )}

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

        <div className="auth-divider">或</div>
        <button type="button" className="btn ghost block" onClick={onOffline} title="不连接服务器，仅体验界面与设置">
          离线试用
        </button>
      </form>
    </div>
  );
}

function ChatView({ offline = false, onExitOffline }: { offline?: boolean; onExitOffline?: () => void }) {
  const {
    status,
    me,
    rooms,
    activeRoomId,
    membersByRoom,
    messagesByRoom,
    loadingRooms,
    roomError,
    connectionError,
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

  // 进入聊天视图自动连接（connect 幂等，StrictMode 双挂载安全）；离线模式不连接
  useEffect(() => {
    if (offline) return;
    connect();
    return () => disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offline]);

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
          {offline && (
            <div className="rooms-hint">
              离线模式：未连接服务器
              <br />
              房间/聊天不可用，可体验设置与游戏模式
            </div>
          )}
          {!offline && loadingRooms && rooms.length === 0 && <div className="rooms-hint">加载中…</div>}
          {!offline && !loadingRooms && rooms.length === 0 && (
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
          <Avatar name={offline ? '访客' : (user?.username ?? '')} url={user?.avatarUrl} size={32} />
          <div className="user-info">
            <div className="user-name">{offline ? '离线访客' : user?.username}</div>
            <div className="user-id">{offline ? '未登录' : `#${user?.id.slice(0, 8)}`}</div>
          </div>
          {!offline && (
            <button className="btn ghost small" title="退出登录" onClick={logout}>
              退出
            </button>
          )}
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="topbar-title">
            <span className="hash">#</span>
            <span>{offline ? '离线模式' : (activeRoom?.name ?? '未选择房间')}</span>
            {activeRoom && !offline && <span className="me-tag">邀请码 {activeRoom.inviteCode}</span>}
          </div>
          <div className="topbar-right">
            {offline && <span className="offline-tag">离线模式</span>}
            {!offline && gameModeEnabled && <span className="game-mode-tag">游戏模式</span>}
            <label className="sound-toggle" title="消息提示音">
              <input type="checkbox" checked={soundEnabled} onChange={(e) => setSoundEnabled(e.target.checked)} />
              声音
            </label>
            <span className="member-count">{offline ? '未连接' : `${members.length} 人在线`}</span>
            <StatusDot status={status} />
            {!offline && (
              <button className="btn ghost small" onClick={connected ? disconnect : connect}>
                {connected ? '断开' : '连接'}
              </button>
            )}
            <button className="btn ghost small" onClick={() => setShowSettings(true)}>
              设置
            </button>
            {offline && (
              <button className="btn ghost small" onClick={onExitOffline}>
                退出离线
              </button>
            )}
          </div>
        </header>

        {connectionError && (
          <div className="banner-error">
            <span>
              <strong>无法连接服务器：</strong>
              {connectionError}
            </span>
            <button
              className="btn ghost small"
              onClick={() => {
                disconnect();
                connect();
              }}
            >
              重试
            </button>
          </div>
        )}

        {roomError && (
          <div className="banner-error">
            <span>{roomError}</span>
            <button className="btn ghost small" onClick={clearRoomError}>
              关闭
            </button>
          </div>
        )}

        <div className="messages" ref={listRef}>
          {offline && (
            <div className="empty">
              <p className="empty-title">离线模式</p>
              <p className="empty-sub">
                未连接服务器，房间与聊天不可用。可前往「设置」体验游戏模式、快捷键与 Overlay 配置。
              </p>
            </div>
          )}
          {!offline && !activeRoom && (
            <div className="empty">
              <p className="empty-title">选择一个房间</p>
              <p className="empty-sub">创建新房间或通过邀请码加入，开始实时沟通。</p>
              <button className="btn primary" style={{ marginTop: 14 }} onClick={() => setShowRoomModal(true)}>
                创建 / 加入房间
              </button>
            </div>
          )}
          {!offline && activeRoom && messages.length === 0 && (
            <div className="empty">
              <p className="empty-title">欢迎来到 #{activeRoom.name}</p>
              <p className="empty-sub">发送第一条消息，开始与房间里的玩家实时沟通。</p>
            </div>
          )}
          {messages.map((m) => (
            <div key={m.id} className={`message ${m.userId === me?.id ? 'mine' : ''}`}>
              <Avatar name={m.username} url={m.avatarUrl} size={30} />
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
            placeholder={offline ? '离线模式：未连接服务器' : connected ? (activeRoom ? '输入消息，Enter 发送' : '先选择或创建房间') : '未连接'}
            disabled={offline || !connected || !activeRoom}
            maxLength={2000}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !offline && connected && activeRoom) {
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
            disabled={offline || !connected || !activeRoom || !draft.trim()}
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

function ClosePromptModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal close-prompt" onClick={(e) => e.stopPropagation()}>
        <h3>退出 GameTalk？</h3>
        <p className="close-prompt-sub">
          关闭到托盘后，仍可在系统托盘图标中重新打开，并继续接收房间消息。
        </p>
        <div className="row-between">
          <button className="btn ghost" onClick={onClose}>
            取消
          </button>
          <div className="row-between">
            <button
              className="btn ghost"
              onClick={() => {
                onClose();
                void getCurrentWindow().hide();
              }}
            >
              关闭到托盘
            </button>
            <button
              className="btn primary"
              onClick={() => {
                onClose();
                void invoke('quit_app');
              }}
            >
              退出
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const { token, user, refreshMe } = useAuth();
  const [showClosePrompt, setShowClosePrompt] = useState(false);
  const [offline, setOffline] = useState(false);

  // 启动时校验持久化的 token
  useEffect(() => {
    if (token && !user) void refreshMe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 关闭确认监听提升到根组件：登录页/聊天页都能响应窗口关闭
  // （否则登录页时 Rust 已拦截关闭但前端无监听，窗口将无法关闭）
  useEffect(() => {
    let off: UnlistenFn | undefined;
    void listen('main-close-requested', () => setShowClosePrompt(true)).then((fn) => (off = fn));
    return () => off?.();
  }, []);

  return (
    <>
      {offline ? (
        <ChatView offline onExitOffline={() => setOffline(false)} />
      ) : token && user ? (
        <ChatView />
      ) : (
        <LoginView onOffline={() => setOffline(true)} />
      )}
      {showClosePrompt && <ClosePromptModal onClose={() => setShowClosePrompt(false)} />}
    </>
  );
}
