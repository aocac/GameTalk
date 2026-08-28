import { Fragment, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useChat } from './stores/chat';
import * as api from './app/api';
import type { UserBrief } from './app/types';
import type { RoomMessage } from './app/api';
import { useAuth } from './stores/auth';
import { useSettings, applyProxySetting, type OverlayPosition } from './app/settings';
import * as gameMode from './app/gameMode';
import HotkeyRecorder from './components/HotkeyRecorder';
import appIcon from './assets/app-icon.png';

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

const MAX_AVATAR_BYTES = 3 * 1024 * 1024; // 3MB

/** 消息日期分隔文案：今天 / 昨天 / M月D日 */
function formatDay(ts: string): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, now)) return '今天';
  if (sameDay(d, yesterday)) return '昨天';
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 房间列表预览时间：今天显示 HH:MM，否则 M/D */
function formatRoomTime(ts: string): string {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** 是否与上一条消息同人连发（5 分钟内）：合并头像与昵称（QQ 式） */
function isGroupedWithPrev(prev: RoomMessage | undefined, cur: RoomMessage): boolean {
  if (!prev || prev.userId !== cur.userId) return false;
  if (prev.pending || cur.pending) return false;
  if (new Date(cur.createdAt).toDateString() !== new Date(prev.createdAt).toDateString()) return false;
  return new Date(cur.createdAt).getTime() - new Date(prev.createdAt).getTime() < 5 * 60 * 1000;
}

/** 剪贴板复制（webview 安全上下文下可用），成功返回 true */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** 个人资料：头像 / 昵称 / 个性签名 / ID / 注册时间（与软件设置分离） */
function ProfileModal({ onClose }: { onClose: () => void }) {
  const { user, updateProfile, uploadAvatar, busy } = useAuth();
  const [username, setUsername] = useState(user?.username ?? '');
  const [bio, setBio] = useState(user?.bio ?? '');
  const [msg, setMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const onAvatarFile = async (file: File | undefined) => {
    setMsg(null);
    if (!file) return;
    if (file.size > MAX_AVATAR_BYTES) {
      setMsg('图片需 ≤3MB，请换一张更小的图');
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = String(reader.result ?? '');
      try {
        await uploadAvatar(dataUrl);
        setMsg('头像已更新');
      } catch {
        setMsg('上传失败（仅支持 PNG/JPEG/WebP/GIF）');
      }
    };
    reader.readAsDataURL(file);
  };

  const save = async () => {
    setMsg(null);
    try {
      await updateProfile({ username: username.trim() || user?.username, bio });
      setMsg('已保存');
    } catch {
      setMsg(null);
    }
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal profile-modal" onClick={(e) => e.stopPropagation()}>
        <h3>个人资料</h3>
        <div className="profile-hero">
          <button className="avatar-btn" title="点击更换头像" onClick={() => fileRef.current?.click()}>
            <Avatar name={username || user?.username || ''} url={user?.avatarUrl} size={60} />
          </button>
          <div className="profile-hero-info">
            <div className="profile-name">{user?.username}</div>
            <button
              className="id-row"
              title="点击复制 ID"
              onClick={async () => {
                if (user && (await copyText(user.id))) {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }
              }}
            >
              <span className="user-id">#{user?.id.slice(0, 8)}</span>
              <span className="id-copy">{copied ? '已复制 ✓' : '复制 ID'}</span>
            </button>
            <div className="profile-meta">注册于 {user ? new Date(user.createdAt).toLocaleDateString() : '—'}</div>
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
        {msg && <span className={msg.includes('失败') || msg.includes('需') ? 'err-text' : 'ok-text'}>{msg}</span>}
        <label className="field">
          <span>昵称</span>
          <input value={username} maxLength={24} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label className="field">
          <span>个性签名</span>
          <textarea
            className="bio-input"
            value={bio}
            maxLength={100}
            rows={2}
            placeholder="写一句话介绍自己…"
            onChange={(e) => setBio(e.target.value)}
          />
          <span className="field-hint bio-count">{bio.length}/100</span>
        </label>
        <button className="btn primary block" disabled={busy} onClick={() => void save()}>
          {busy ? '保存中…' : '保存'}
        </button>
      </div>
    </div>
  );
}

/** 成员卡片：点击成员查看公开资料；房主可直接移出 */
function MemberCardModal({
  member,
  isOwner,
  canKick,
  onKick,
  onClose,
}: {
  member: UserBrief;
  isOwner: boolean;
  canKick: boolean;
  onKick: () => void;
  onClose: () => void;
}) {
  const { token } = useAuth();
  const [profile, setProfile] = useState<api.MemberProfile | null>(null);
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [copied, setCopied] = useState(false);
  const [confirmKick, setConfirmKick] = useState(false);
  const kickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    if (token) {
      api
        .getUserProfile(token, member.id)
        .then((r) => {
          if (!cancelled) setProfile(r.user);
        })
        .catch(() => {
          if (!cancelled) setFailed(true);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [token, member.id, reloadKey]);

  const handleKick = () => {
    if (!confirmKick) {
      setConfirmKick(true);
      kickTimer.current = setTimeout(() => setConfirmKick(false), 3000);
      return;
    }
    if (kickTimer.current) clearTimeout(kickTimer.current);
    onKick();
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal member-card" onClick={(e) => e.stopPropagation()}>
        <div className="card-hero">
          <Avatar name={member.username} url={profile?.avatarUrl ?? member.avatarUrl} size={56} />
          <div className="card-name-row">
            <span className="card-name">{member.username}</span>
            {isOwner && <span className="owner-chip">房主</span>}
          </div>
        </div>
        <div className="card-bio">
          {failed ? (
            <span className="card-failed">
              资料获取失败（服务器版本过旧或网络异常）
              <button className="card-retry" onClick={() => setReloadKey((k) => k + 1)}>
                重试
              </button>
            </span>
          ) : (
            profile?.bio || '这个人很神秘，什么都没有写'
          )}
        </div>
        <button
          className="id-row"
          title="点击复制 ID"
          onClick={async () => {
            if (await copyText(member.id)) {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }
          }}
        >
          <span className="user-id">#{member.id.slice(0, 8)}</span>
          <span className="id-copy">{copied ? '已复制 ✓' : '复制 ID'}</span>
        </button>
        {profile && <div className="card-meta">注册于 {new Date(profile.createdAt).toLocaleDateString()}</div>}
        {canKick && (
          <button className={`btn ghost block danger ${confirmKick ? 'confirming' : ''}`} onClick={handleKick}>
            {confirmKick ? '确认移出该成员？' : '移出房间'}
          </button>
        )}
      </div>
    </div>
  );
}

/** 软件设置：服务器 / 声音 / 代理 / 游戏模式 / Overlay（个人资料在头像菜单单独入口） */
function SettingsModal({ onClose }: { onClose: () => void }) {
  const {
    serverUrl,
    setServerUrl,
    setSoundEnabled,
    gameModeEnabled,
    setGameModeEnabled,
    hotkey,
    setHotkey,
    overlayPosition,
    setOverlayPosition,
    setOverlayCustomPosition,
    overlayScale,
    setOverlayScale,
    overlayDurationSec,
    setOverlayDurationSec,
    useProxy,
    setUseProxy,
    proxyAddress,
    setProxyAddress,
    soundEnabled,
  } = useSettings();
  const [proxyMsg, setProxyMsg] = useState<string | null>(null);

  // 用户主动调整位置/缩放：立即应用 + 5 秒预览（Overlay 平时隐藏，必须主动显示让用户看到效果）
  // 显式传入 position，不依赖 store 中转（修复 select 选择后位置未应用的问题）
  const applyAndPreview = (position?: OverlayPosition) => {
    void gameMode.stopOverlayAdjust();
    if (position) setOverlayPosition(position);
    void gameMode.applyOverlayConfig(position).then(() => void gameMode.previewOverlay());
  };

  const closeModal = () => {
    // 防止调整模式残留卡死
    void gameMode.stopOverlayAdjust();
    onClose();
  };

  const onHotkeyChange = (v: string) => {
    setHotkey(v);
    if (gameModeEnabled) void gameMode.reapplyHotkey();
  };

  return (
    <div className="modal-mask" onClick={closeModal}>
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <h3>设置</h3>

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
          <span className="section-title">网络代理</span>
          <label className="field">
            <span>启用代理（默认关闭 = 直连，不走系统代理）</span>
            <div className="switch-row">
              <input
                type="checkbox"
                checked={useProxy}
                onChange={(e) => {
                  setUseProxy(e.target.checked);
                  void applyProxySetting(e.target.checked, proxyAddress);
                  setProxyMsg('已应用（立即生效）');
                  setTimeout(() => setProxyMsg(null), 2000);
                }}
              />
              {useProxy ? '已启用' : '已关闭'}
            </div>
          </label>
          {useProxy && (
            <label className="field">
              <span>代理地址（HTTP 混合代理，如 127.0.0.1:7890）</span>
              <input
                value={proxyAddress}
                placeholder="127.0.0.1:7890"
                onChange={(e) => {
                  setProxyAddress(e.target.value);
                  void applyProxySetting(true, e.target.value);
                  setProxyMsg('已应用（立即生效）');
                  setTimeout(() => setProxyMsg(null), 2000);
                }}
              />
              {proxyMsg && <span className="ok-text">{proxyMsg}</span>}
            </label>
          )}
          <span className="field-hint">
            连接国内/自建服务器建议保持关闭（直连最快）；仅当服务器需要经代理访问时再开启。
          </span>
        </div>

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
          <div className="field">
            <span>显示位置（点击即应用并预览 5 秒）</span>
            <div className="position-chips">
              {Object.entries(POSITION_LABELS).map(([v, label]) => (
                <button
                  key={v}
                  type="button"
                  className={`chip ${v === overlayPosition ? 'active' : ''}`}
                  onClick={() => {
                    if (v === 'custom') {
                      // 选择「自定义」= 进入拖拽调整，保持当前位置，绝不跳位；
                      // 只同步窗口尺寸（move:false），不应用已保存的自定义坐标
                      setOverlayPosition(v);
                      void gameMode.stopOverlayAdjust();
                      void gameMode
                        .applyOverlayConfig(undefined, { move: false })
                        .then(() => void gameMode.startOverlayAdjust());
                    } else {
                      // 预设：立即应用 + 5 秒预览（每次点击必触发，即使值与当前相同）
                      applyAndPreview(v as OverlayPosition);
                    }
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            <span className="position-current">当前位置：{POSITION_LABELS[overlayPosition]}</span>
          </div>
          <button
            className="btn ghost block"
            onClick={() => {
              void gameMode.stopOverlayAdjust();
              setOverlayCustomPosition(null);
              applyAndPreview('top-left');
            }}
          >
            复位到左上角
          </button>
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
                applyAndPreview();
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
              onChange={(e) => {
                setOverlayDurationSec(parseInt(e.target.value, 10));
                // 显式传播新时长到 Overlay（不移动窗口）
                void gameMode.applyOverlayConfig(undefined, { move: false });
              }}
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
          <img src={appIcon} alt="GameTalk" className="logo-img big" draggable={false} />
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
                onChange={(e) => {
                  setServerDraft(e.target.value);
                  // 实时保存：防止忘记点「保存」就登录导致仍用旧地址
                  setServerUrl(e.target.value);
                  // 地址变了，之前的连接错误提示不再适用，清掉
                  clearError();
                }}
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
    subscribedRoomIds,
    unreadByRoom,
    historyLoadedRooms,
    hasMoreByRoom,
    loadingOlderRooms,
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
    loadOlderMessages,
    leaveActiveRoom,
    deleteActiveRoom,
    kickMember,
    sendMessage,
    clearRoomError,
  } = useChat();
  const { user, logout } = useAuth();
  const { soundEnabled, setSoundEnabled } = useSettings();
  const [draft, setDraft] = useState('');
  const [confirmDeleteRoom, setConfirmDeleteRoom] = useState(false);
  /** 踢出二次确认：记录待确认的成员 userId（3s 内再点一次生效） */
  const [confirmKickId, setConfirmKickId] = useState<string | null>(null);
  const kickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 左下角头像二级菜单（个人资料 / 设置 / 退出登录） */
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  /** 成员卡片：当前查看的成员 */
  const [cardMember, setCardMember] = useState<UserBrief | null>(null);
  const [showRoomModal, setShowRoomModal] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [roomName, setRoomName] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  /** 向上翻页 prepend 后的滚动锚定基准（翻页期间的 messages.length 变化不滚到底部） */
  const anchorRef = useRef<number | null>(null);
  const connected = status === 'open';
  const activeRoom = rooms.find((r) => r.id === activeRoomId) ?? null;
  const messages = activeRoomId ? (messagesByRoom[activeRoomId] ?? []) : [];
  const members = activeRoomId ? (membersByRoom[activeRoomId] ?? []) : [];
  const activeSubscribed = !!activeRoomId && subscribedRoomIds.includes(activeRoomId);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (anchorRef.current !== null) {
      // 加载更早消息（prepend）：把滚动位置锚定回原内容，而不是跳到底部
      el.scrollTop = el.scrollHeight - anchorRef.current;
      anchorRef.current = null;
      return;
    }
    el.scrollTo({ top: el.scrollHeight });
  }, [messages.length]);

  const handleLoadOlder = async () => {
    if (!activeRoom || !listRef.current) return;
    anchorRef.current = listRef.current.scrollHeight;
    const before = messages.length;
    await loadOlderMessages(activeRoom.id);
    // 没有新增内容（加载失败/无更早消息）时 effect 不会触发，手动清掉锚定标记
    if ((useChat.getState().messagesByRoom[activeRoom.id] ?? []).length === before) {
      anchorRef.current = null;
    }
  };

  // 进入聊天视图自动连接（connect 幂等，StrictMode 双挂载安全）；离线模式不连接
  useEffect(() => {
    if (offline) return;
    connect();
    return () => disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offline]);

  // 启动时应用已保存的代理设置（默认关闭=直连）
  useEffect(() => {
    const { useProxy: up, proxyAddress: pa } = useSettings.getState();
    void applyProxySetting(up, pa);
  }, []);

  // 游戏模式生命周期：启停快捷键 + Overlay 事件监听
  const { gameModeEnabled } = useSettings();
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

  const handleKick = (m: { id: string }) => {
    if (!activeRoom) return;
    if (confirmKickId !== m.id) {
      setConfirmKickId(m.id);
      if (kickTimer.current) clearTimeout(kickTimer.current);
      kickTimer.current = setTimeout(() => setConfirmKickId(null), 3000);
      return;
    }
    if (kickTimer.current) clearTimeout(kickTimer.current);
    setConfirmKickId(null);
    kickMember(activeRoom.id, m.id);
  };

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
          <img src={appIcon} alt="GameTalk" className="logo-img" draggable={false} />
          <span className="brand-name">GameTalk</span>
        </div>
        <div className="rooms-header">
          <span>房间</span>
          <button
            className="icon-btn"
            title={offline ? '离线模式不可创建/加入房间' : '创建/加入房间'}
            disabled={offline}
            onClick={() => setShowRoomModal(true)}
          >
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
          {rooms.map((r) => {
            const confirmed = (messagesByRoom[r.id] ?? []).filter((x) => !x.pending);
            const lastMsg = confirmed.length > 0 ? confirmed[confirmed.length - 1] : undefined;
            return (
              <div
                key={r.id}
                className={`room-item ${r.id === activeRoomId ? 'active' : ''}`}
                onClick={() => void selectRoom(r.id)}
                title={r.inviteCode}
              >
                <div className="room-main">
                  <div className="room-line1">
                    <span className="room-name">{r.name}</span>
                    {!!unreadByRoom[r.id] && (
                      <span className="room-badge">{unreadByRoom[r.id] > 99 ? '99+' : unreadByRoom[r.id]}</span>
                    )}
                    {lastMsg && <span className="room-time">{formatRoomTime(lastMsg.createdAt)}</span>}
                  </div>
                  {lastMsg && (
                    <div className="room-preview">
                      {lastMsg.username}：{lastMsg.text}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </nav>
        <div className="sidebar-footer user-block">
          <button
            className={`user-trigger ${userMenuOpen ? 'open' : ''}`}
            onClick={() => setUserMenuOpen((v) => !v)}
            title="账号菜单"
          >
            <Avatar name={offline ? '访客' : (user?.username ?? '')} url={user?.avatarUrl} size={32} />
            <div className="user-info">
              <div className="user-name">{offline ? '离线访客' : user?.username}</div>
              <div className="user-id">{offline ? '未登录' : `#${user?.id.slice(0, 8)}`}</div>
            </div>
          </button>
        </div>
        {userMenuOpen && (
          <>
            <div className="menu-mask" onClick={() => setUserMenuOpen(false)} />
            <div className="user-menu">
              <button
                className="user-menu-item"
                onClick={() => {
                  setUserMenuOpen(false);
                  setShowProfile(true);
                }}
              >
                个人资料
              </button>
              <button
                className="user-menu-item"
                onClick={() => {
                  setUserMenuOpen(false);
                  setShowSettings(true);
                }}
              >
                设置
              </button>
              {!offline && (
                <button
                  className="user-menu-item danger"
                  onClick={() => {
                    setUserMenuOpen(false);
                    logout();
                  }}
                >
                  退出登录
                </button>
              )}
            </div>
          </>
        )}
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
            {/* 订阅状态只在已连接时有意义；断开/重连中由状态灯表达 */}
            {!offline && connected && activeRoom && (
              <span
                className={`sub-tag ${activeSubscribed ? 'ok' : 'pending'}`}
                title={activeSubscribed ? '已订阅该房间实时消息' : '订阅未就绪（自动重试中…）'}
              >
                {activeSubscribed ? '订阅 ✓' : '订阅中…'}
              </span>
            )}
            {!offline && (
              <button className="btn ghost small" onClick={connected ? disconnect : connect}>
                {connected ? '断开' : '连接'}
              </button>
            )}
            {!offline && activeRoom && activeRoom.ownerId === me?.id && (
              <button
                className="btn ghost small danger"
                onClick={() => {
                  if (!confirmDeleteRoom) {
                    setConfirmDeleteRoom(true);
                    setTimeout(() => setConfirmDeleteRoom(false), 3000);
                  } else {
                    setConfirmDeleteRoom(false);
                    void deleteActiveRoom();
                  }
                }}
                title="删除房间（仅房主）"
              >
                {confirmDeleteRoom ? '确认删除？' : '删除房间'}
              </button>
            )}
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
          {!offline && activeRoom && hasMoreByRoom[activeRoom.id] && (
            <button
              className="load-older"
              disabled={!!loadingOlderRooms[activeRoom.id]}
              onClick={() => void handleLoadOlder()}
            >
              {loadingOlderRooms[activeRoom.id] ? '加载中…' : '加载更早的消息'}
            </button>
          )}
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
          {!offline && activeRoom && messages.length === 0 && !historyLoadedRooms[activeRoom.id] && (
            <div className="empty">
              <p className="empty-title">加载历史消息…</p>
              <p className="empty-sub">正在从服务器拉取该房间的历史记录。</p>
            </div>
          )}
          {!offline && activeRoom && messages.length === 0 && historyLoadedRooms[activeRoom.id] && (
            <div className="empty">
              <p className="empty-title">欢迎来到 #{activeRoom.name}</p>
              <p className="empty-sub">发送第一条消息，开始与房间里的玩家实时沟通。</p>
            </div>
          )}
          {messages.map((m, i) => {
            const prev = messages[i - 1];
            const grouped = isGroupedWithPrev(prev, m);
            const showDay =
              i === 0 ||
              new Date(m.createdAt).toDateString() !== new Date(prev.createdAt).toDateString();
            return (
              <Fragment key={m.id}>
                {showDay && (
                  <div className="day-divider">
                    <span>{formatDay(m.createdAt)}</span>
                  </div>
                )}
                <div className={`message ${m.userId === me?.id ? 'mine' : ''} ${grouped ? 'grouped' : ''} ${m.pending ? 'pending' : ''}`}>
                  <Avatar name={m.username} url={m.avatarUrl} size={30} />
                  <div className="message-body">
                    <div className="message-head">
                      <span className="message-author">{m.username}</span>
                      <span className="message-time">{m.pending ? '发送中…' : new Date(m.createdAt).toLocaleTimeString()}</span>
                    </div>
                    <div className="message-text">{m.text}</div>
                  </div>
                </div>
              </Fragment>
            );
          })}
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
              // 中文输入法组词期间的 Enter 是确认候选词，不是发送（keyCode 229 为组词键事件兜底）
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
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

      {/* 成员面板（QQ 式）：在线成员 + 房主标注 + 房主踢人 */}
      {!offline && activeRoom && (
        <aside className="members-panel">
          <div className="members-header">
            <span>成员</span>
            <span className="members-count">{members.length}</span>
          </div>
          <div className="members-list">
            {[...members]
              .sort((a, b) => (a.id === me?.id ? -1 : b.id === me?.id ? 1 : 0))
              .map((m) => {
              const isOwner = m.id === activeRoom.ownerId;
              const isSelf = m.id === me?.id;
              const canKick = activeRoom.ownerId === me?.id && !isOwner;
              return (
                <div
                  key={m.id}
                  className={`member-item ${isSelf ? 'self' : ''}`}
                  title="查看资料"
                  onClick={() => setCardMember(m)}
                >
                  <span className="member-avatar">
                    <Avatar name={m.username} url={m.avatarUrl} size={26} />
                  </span>
                  <span className="member-name">
                    {m.username}
                    {isSelf ? '（我）' : ''}
                  </span>
                  {isOwner && (
                    <span className="owner-chip" title="房主">
                      房主
                    </span>
                  )}
                  {canKick && (
                    <button
                      className={`kick-btn ${confirmKickId === m.id ? 'confirm' : ''}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleKick(m);
                      }}
                      title={confirmKickId === m.id ? '再次点击确认移出' : '移出房间'}
                    >
                      {confirmKickId === m.id ? '确认?' : '移出'}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </aside>
      )}

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      {showProfile && <ProfileModal onClose={() => setShowProfile(false)} />}
      {cardMember && activeRoom && (
        <MemberCardModal
          member={cardMember}
          isOwner={cardMember.id === activeRoom.ownerId}
          canKick={activeRoom.ownerId === me?.id && cardMember.id !== me?.id}
          onKick={() => {
            kickMember(activeRoom.id, cardMember.id);
            setCardMember(null);
          }}
          onClose={() => setCardMember(null)}
        />
      )}

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
