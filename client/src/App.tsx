import { Fragment, useLayoutEffect, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useChat } from './stores/chat';
import { useFriends } from './stores/friends';
import { useNotifications } from './stores/notifications';
import * as api from './app/api';
import type { MentionRef, RoomMember, UserBrief } from './app/types';
import type { RoomMessage } from './app/api';
import { useAuth } from './stores/auth';
import { useSettings, applyProxySetting, type OverlayPosition } from './app/settings';
import * as gameMode from './app/gameMode';
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

/** 右键菜单容器：渲染后按实际尺寸夹紧视口边界（防菜单底部/右侧被窗口裁切） */
function CtxMenu({ x, y, children }: { x: number; y: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)),
    });
  }, [x, y]);
  return (
    <div ref={ref} className="ctx-menu" style={{ left: pos.left, top: pos.top }}>
      {children}
    </div>
  );
}

const MAX_AVATAR_BYTES = 3 * 1024 * 1024; // 3MB

/** 表情面板数据（精选常用集合，纯 Unicode，零资源文件） */
const EMOJIS = [
  '😀', '😂', '🤣', '😊', '😍', '😘', '😜', '🤔', '😎', '🥳', '😭', '😅',
  '🙃', '😴', '🤯', '🥺', '😡', '😱', '🤗', '🤫', '🤭', '😏', '😌', '🙄',
  '😐', '🤡', '👻', '💀', '🤖', '👽', '🎃', '👊', '👍', '👎', '👌', '✌️',
  '🤙', '💪', '🙏', '👏', '🤝', '🎮', '🕹️', '💻', '⌨️', '📱', '🏆', '🎯',
  '⚡', '🔥', '💥', '⭐', '🌈', '☀️', '🌙', '💡', '🎉', '🎊', '🎁', '❤️',
  '💔', '💯', '🍺', '🍻', '🥤', '🍕', '🍗', '🍜', '🀄', '🎲', '🚀', '🐴',
];

/** 常用表情按账号隔离（换账号不继承） */
function loadRecentEmojis(userId: string): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(`gt-emoji-recent#${userId}`) ?? '[]');
    return Array.isArray(list) ? list.filter((e) => typeof e === 'string').slice(0, 16) : [];
  } catch {
    return [];
  }
}

function saveRecentEmoji(e: string, userId: string): string[] {
  const list = [e, ...loadRecentEmojis(userId).filter((x) => x !== e)].slice(0, 16);
  try {
    localStorage.setItem(`gt-emoji-recent#${userId}`, JSON.stringify(list));
  } catch {
    // 忽略存储失败
  }
  return list;
}

/** 图片文件 → 压缩后的 data URL（最长边 1920，JPEG 0.85；GIF 保留原样避免丢动画） */
async function fileToCompressedDataUrl(file: File): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ''));
    r.onerror = () => reject(new Error('read failed'));
    r.readAsDataURL(file);
  });
  if (file.type === 'image/gif') return dataUrl;
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('decode failed'));
    img.src = dataUrl;
  });
  const scale = Math.min(1, 1920 / Math.max(img.width, img.height));
  if (scale === 1 && file.size <= 2 * 1024 * 1024) return dataUrl;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.width * scale));
  canvas.height = Math.max(1, Math.round(img.height * scale));
  canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.85);
}

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

/** 把消息文本中对应提及快照的 @用户名 高亮 */
function renderMentions(text: string, mentions?: MentionRef[]): string | ReactElement {
  const names = (mentions ?? []).map((m) => m.username).filter(Boolean);
  if (names.length === 0) return text;
  const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`@(${escaped.join('|')})`, 'g');
  const parts: Array<string | ReactElement> = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const idx = m.index ?? 0;
    if (idx > last) parts.push(text.slice(last, idx));
    parts.push(
      <span key={idx} className="mention">
        @{m[1]}
      </span>,
    );
    last = idx + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

/** 复制图片到剪贴板（非 PNG 先经 canvas 转 PNG；剪贴板不支持时给出提示） */
async function copyImageToClipboard(url: string): Promise<void> {
  try {
    if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
      throw new Error('clipboard unsupported');
    }
    const res = await fetch(url);
    const blob = await res.blob();
    let png = blob;
    if (blob.type !== 'image/png') {
      const bmp = await createImageBitmap(blob);
      const c = document.createElement('canvas');
      c.width = bmp.width;
      c.height = bmp.height;
      c.getContext('2d')!.drawImage(bmp, 0, 0);
      png = await new Promise<Blob>((resolve) => c.toBlob((b) => resolve(b!), 'image/png'));
    }
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
  } catch {
    useChat.setState({ roomError: '复制图片失败（剪贴板不可用或图片加载失败）' });
  }
}

/** 打开独立设置窗口（Tauri 运行时创建；浏览器调试回退为普通标签页） */
async function openSettingsWindow(): Promise<void> {
  const existing = await import('@tauri-apps/api/webviewWindow')
    .then(({ WebviewWindow }) => WebviewWindow.getByLabel('settings'))
    .catch(() => null);
  if (existing) {
    void existing.show();
    void existing.setFocus();
    return;
  }
  try {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    new WebviewWindow('settings', {
      title: 'GameTalk 设置',
      url: 'settings.html',
      width: 820,
      height: 600,
      minWidth: 720,
      minHeight: 520,
      center: true,
      resizable: true,
    });
  } catch {
    window.open('settings.html', '_blank');
  }
}

/** 通知中心面板：@提及 / 好友事件聚合（会话级） */
function NotificationPanel({
  onGoRoom,
  onGoFriends,
  onClose,
}: {
  onGoRoom: (roomId: string) => void;
  onGoFriends: () => void;
  onClose: () => void;
}) {
  const { items, markAllRead, clear } = useNotifications();
  return (
    <>
      <div className="menu-mask" onClick={onClose} />
      <div className="notif-panel">
        <div className="notif-head">
          <span>通知中心</span>
          <div className="row-gap">
            <button className="notif-action" onClick={markAllRead}>
              全部已读
            </button>
            <button className="notif-action" onClick={clear}>
              清空
            </button>
          </div>
        </div>
        <div className="notif-list">
          {items.length === 0 && <div className="notif-empty">暂无通知</div>}
          {items.map((n) => (
            <button
              key={n.id}
              className={`notif-item ${n.read ? '' : 'unread'}`}
              onClick={() => {
                if (n.kind === 'mention' && n.roomId) onGoRoom(n.roomId);
                else if (n.kind === 'friend_request') onGoFriends();
                onClose();
              }}
            >
              <span className={`notif-dot ${n.kind}`} />
              <span className="notif-text">{n.text}</span>
              <span className="notif-time">{new Date(n.createdAt).toLocaleTimeString()}</span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
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

/** 成员卡片：点击成员查看公开资料；房主可移出；可加/删好友 */
function MemberCardModal({
  member,
  isOwner,
  canKick,
  onKick,
  friendStatus,
  onAddFriend,
  onRemoveFriend,
  onClose,
}: {
  member: UserBrief;
  isOwner: boolean;
  canKick: boolean;
  onKick: () => void;
  friendStatus?: 'self' | 'friends' | 'pending' | 'none';
  onAddFriend?: () => void;
  onRemoveFriend?: () => void;
  onClose: () => void;
}) {
  const { token } = useAuth();
  const [profile, setProfile] = useState<api.MemberProfile | null>(null);
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [copied, setCopied] = useState(false);
  const [confirmKick, setConfirmKick] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const kickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const removeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const handleRemoveFriend = () => {
    if (!confirmRemove) {
      setConfirmRemove(true);
      removeTimer.current = setTimeout(() => setConfirmRemove(false), 3000);
      return;
    }
    if (removeTimer.current) clearTimeout(removeTimer.current);
    onRemoveFriend?.();
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
        {friendStatus === 'none' && onAddFriend && (
          <button className="btn primary block" onClick={onAddFriend}>
            添加好友
          </button>
        )}
        {friendStatus === 'pending' && (
          <button className="btn ghost block" disabled>
            好友申请处理中
          </button>
        )}
        {friendStatus === 'friends' && onRemoveFriend && (
          <button className={`btn ghost block danger ${confirmRemove ? 'confirming' : ''}`} onClick={handleRemoveFriend}>
            {confirmRemove ? '确认删除好友？' : '删除好友'}
          </button>
        )}
        {canKick && (
          <button className={`btn ghost block danger ${confirmKick ? 'confirming' : ''}`} onClick={handleKick}>
            {confirmKick ? '确认移出该成员？' : '移出房间'}
          </button>
        )}
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
    previewByRoom,
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
    deleteRoom,
    kickMember,
    muteMember,
    unmuteMember,
    recallMessage,
    sendMessage,
    clearRoomError,
  } = useChat();
  const { user, logout } = useAuth();
  const { gameModeEnabled, hotkey, soundEnabled } = useSettings();
  const [draft, setDraft] = useState('');
  const [roomMenu, setRoomMenu] = useState<{ id: string; invite: string; isOwner: boolean; x: number; y: number } | null>(null);
  const [confirmDeleteInMenu, setConfirmDeleteInMenu] = useState(false);
  /** 成员右键菜单：目标成员 + 位置（@提及 / 加好友 / 房主管理） */
  const [memberMenu, setMemberMenu] = useState<{ member: RoomMember; x: number; y: number; confirmKick: boolean } | null>(null);
  /** 消息右键菜单：复制 / 引用 / 撤回 */
  const [msgMenu, setMsgMenu] = useState<{ msg: RoomMessage; x: number; y: number } | null>(null);
  /** 左下角头像二级菜单（个人资料 / 设置 / 退出登录） */
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  /** 成员卡片：当前查看的成员 */
  const [cardMember, setCardMember] = useState<UserBrief | null>(null);
  const [showRoomModal, setShowRoomModal] = useState(false);
  const [roomName, setRoomName] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  /** 侧栏双 Tab（QQ 式）：消息=房间列表 / 好友=好友管理 */
  const [sideTab, setSideTab] = useState<'rooms' | 'friends'>('rooms');
  const [addFriendInput, setAddFriendInput] = useState('');
  /** 通知中心 */
  const [showNotif, setShowNotif] = useState(false);
  const { unread: notifUnread, markAllRead } = useNotifications();
  /** @自动补全：start=草稿中 @ 的位置，caret=当前光标 */
  const [mentionQuery, setMentionQuery] = useState<{ start: number; token: string; caret: number } | null>(null);
  const [mentionPick, setMentionPick] = useState(0);
  const pickedMentions = useRef<Map<string, string>>(new Map());
  const composerRef = useRef<HTMLInputElement>(null);
  /** 图片消息 / 表情面板 / 灯箱 */
  const [uploading, setUploading] = useState(false);
  const [showEmoji, setShowEmoji] = useState(false);
  const emojiOwner = me?.id ?? 'guest';
  const [recentEmojis, setRecentEmojis] = useState<string[]>(() => loadRecentEmojis(emojiOwner));
  // 换账号后重读该账号的常用表情
  useEffect(() => {
    setRecentEmojis(loadRecentEmojis(emojiOwner));
  }, [emojiOwner]);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [lightboxZoom, setLightboxZoom] = useState(1);
  const [lightboxOffset, setLightboxOffset] = useState({ x: 0, y: 0 });
  const lightboxDrag = useRef<{ id: number; sx: number; sy: number; ox: number; oy: number; lx: number; ly: number } | null>(null);
  const lightboxMoved = useRef(false);
  const imageInputRef = useRef<HTMLInputElement>(null);
  /** 待发送图片附件：上传完成后先挂起，可配文字，手动发送 */
  const [pendingImage, setPendingImage] = useState<string | null>(null);
  /** 引用回复：待回复的原消息（发送后气泡内渲染引用块） */
  const [replyTo, setReplyTo] = useState<RoomMessage | null>(null);
  const {
    friends,
    incoming: friendIncoming,
    notice: friendNotice,
    error: friendsError,
    load: loadFriends,
    sendRequest,
    accept: acceptFriend,
    decline: declineFriend,
    remove: removeFriendById,
    relationOf,
    clearNotice,
  } = useFriends();
  const listRef = useRef<HTMLDivElement>(null);
  /** 向上翻页 prepend 后的滚动锚定基准（翻页期间的 messages.length 变化不滚到底部） */
  const anchorRef = useRef<number | null>(null);
  const connected = status === 'open';
  const activeRoom = rooms.find((r) => r.id === activeRoomId) ?? null;
  const messages = activeRoomId ? (messagesByRoom[activeRoomId] ?? []) : [];
  const members = activeRoomId ? (membersByRoom[activeRoomId] ?? []) : [];
  // 花名册排序：自己 → 房主 → 在线 → 离线（QQ 式）；同级按昵称稳定排序
  const memberRank = (id: string, online: boolean) => (id === me?.id ? 0 : id === activeRoom?.ownerId ? 1 : online ? 2 : 3);
  const roster = [...members].sort(
    (a, b) => memberRank(a.id, a.online) - memberRank(b.id, b.online) || a.username.localeCompare(b.username),
  );
  const onlineCount = members.filter((m) => m.online).length;
  const activeSubscribed = !!activeRoomId && subscribedRoomIds.includes(activeRoomId);
  // @自动补全候选：当前房间花名册（自己除外），按昵称前缀过滤
  const mentionCandidates: RoomMember[] = mentionQuery
    ? roster
        .filter((m) => m.id !== me?.id && m.username.toLowerCase().startsWith(mentionQuery.token.toLowerCase()))
        .slice(0, 8)
    : [];

  const applyMentionPick = (m: RoomMember) => {
    if (!mentionQuery) return;
    const before = draft.slice(0, mentionQuery.start);
    const after = draft.slice(mentionQuery.caret);
    const inserted = `${before}@${m.username} ${after}`;
    setDraft(inserted);
    pickedMentions.current.set(m.id, m.username);
    setMentionQuery(null);
    requestAnimationFrame(() => {
      const pos = (before + `@${m.username} `).length;
      composerRef.current?.focus();
      composerRef.current?.setSelectionRange(pos, pos);
    });
  };

  const sendDraft = () => {
    if (!activeRoom) return;
    if (!draft.trim() && !pendingImage) return;
    // 只保留文本中确实还带着 @昵称 的提及（用户可能删掉了部分）
    const picks = [...pickedMentions.current.entries()]
      .filter(([, name]) => draft.includes(`@${name}`))
      .map(([id]) => id);
    sendMessage(draft.trim(), {
      mentions: picks,
      mediaUrl: pendingImage ?? undefined,
      replyTo: replyTo?.id,
      reply: replyTo
        ? {
            id: replyTo.id,
            username: replyTo.username,
            text: replyTo.kind === 'image' ? '[图片]' : replyTo.recalled ? '消息已撤回' : replyTo.text.slice(0, 80),
            kind: replyTo.kind === 'image' ? 'image' : 'text',
          }
        : undefined,
    });
    pickedMentions.current.clear();
    setDraft('');
    setMentionQuery(null);
    setPendingImage(null);
    setReplyTo(null);
  };

  // 相对媒体路径 → 绝对 URL（乐观消息里是 /api/media/:id 相对路径）
  const absUrl = (u: string) => (u.startsWith('http') ? u : useSettings.getState().serverUrl.replace(/\/+$/, '') + u);

  const onPickImageFile = async (file: File | undefined) => {
    if (!file || offline || !connected || !activeRoom) return;
    setUploading(true);
    try {
      const { token } = useAuth.getState();
      if (!token) return;
      const dataUrl = await fileToCompressedDataUrl(file);
      const { url } = await api.uploadImage(token, dataUrl);
      // 只挂为待发送附件：可与文字一起编辑，手动发送
      setPendingImage(url);
    } catch (e) {
      useChat.setState({ roomError: e instanceof Error ? e.message : '图片上传失败' });
    } finally {
      setUploading(false);
    }
  };

  const openLightbox = (url: string) => {
    setLightbox(url);
    setLightboxZoom(1);
    setLightboxOffset({ x: 0, y: 0 });
  };

  const saveLightboxImage = async (url: string) => {
    try {
      const res = await fetch(url);
      const blob = await res.blob();
      const ext = blob.type === 'image/jpeg' ? 'jpg' : blob.type === 'image/gif' ? 'gif' : blob.type === 'image/webp' ? 'webp' : 'png';
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `gametalk-image-${Date.now()}.${ext}`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch {
      useChat.setState({ roomError: '图片保存失败' });
    }
  };

  const insertEmoji = (e: string) => {
    const el = composerRef.current;
    const pos = el?.selectionStart ?? draft.length;
    const next = draft.slice(0, pos) + e + draft.slice(pos);
    setDraft(next);
    setRecentEmojis(saveRecentEmoji(e, emojiOwner));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(pos + e.length, pos + e.length);
    });
  };

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

  // 独立设置窗口的变更经事件回流主窗口：更新 store 并执行主窗口侧效果（快捷键/Overlay/代理）
  useEffect(() => {
    let offChanged: UnlistenFn | undefined;
    let offAdjust: UnlistenFn | undefined;
    void listen<{ key?: string; value?: unknown }>('settings:changed', (e) => {
      const { key, value } = e.payload ?? {};
      if (!key) return;
      const s = useSettings.getState();
      switch (key) {
        case 'serverUrl':
          s.setServerUrl(String(value));
          break;
        case 'soundEnabled':
          s.setSoundEnabled(!!value);
          break;
        case 'gameModeEnabled':
          s.setGameModeEnabled(!!value);
          break;
        case 'hotkey':
          s.setHotkey(String(value));
          if (s.gameModeEnabled) void gameMode.reapplyHotkey();
          break;
        case 'overlayPosition':
          s.setOverlayPosition(value as OverlayPosition);
          void gameMode.applyOverlayConfig(value as OverlayPosition).then(() => void gameMode.previewOverlay());
          break;
        case 'overlayScale':
          s.setOverlayScale(value as number);
          void gameMode.applyOverlayConfig(undefined, { move: false });
          break;
        case 'overlayDurationSec':
          s.setOverlayDurationSec(value as number);
          void gameMode.applyOverlayConfig(undefined, { move: false });
          break;
        case 'overlayReset':
          s.setOverlayCustomPosition(null);
          s.setOverlayPosition('top-left');
          void gameMode.stopOverlayAdjust();
          void gameMode.applyOverlayConfig('top-left').then(() => void gameMode.previewOverlay());
          break;
        case 'useProxy':
          s.setUseProxy(!!value);
          void applyProxySetting(!!value, s.proxyAddress);
          break;
        case 'proxyAddress':
          s.setProxyAddress(String(value));
          void applyProxySetting(s.useProxy, String(value));
          break;
        default:
          break;
      }
    }).then((fn) => (offChanged = fn));
    void listen<{ active?: boolean }>('settings:adjust-overlay', (e) => {
      if (e.payload?.active) {
        void gameMode.stopOverlayAdjust();
        void gameMode
          .applyOverlayConfig(undefined, { move: false })
          .then(() => void gameMode.startOverlayAdjust());
      } else {
        void gameMode.stopOverlayAdjust();
      }
    }).then((fn) => (offAdjust = fn));
    return () => {
      offChanged?.();
      offAdjust?.();
    };
  }, []);

  // 游戏模式生命周期：启停快捷键 + Overlay 事件监听
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

  const handleAddFriend = async () => {
    if (await sendRequest(addFriendInput.trim())) setAddFriendInput('');
  };

  // 灯箱拖拽（window 级 mouse 监听，松手必停；拖拽结束的那次点击不关闭灯箱）
  useEffect(() => {
    if (!lightbox) return;
    const onMove = (e: MouseEvent) => {
      const d = lightboxDrag.current;
      if (!d) return;
      // 关键兜底：部分环境 mouseup 会丢（拖出窗口/合成输入），move 时按键已松开即结束拖拽
      if (e.buttons === 0) {
        setLightboxOffset({ x: d.ox + (e.clientX - d.sx), y: d.oy + (e.clientY - d.sy) });
        lightboxDrag.current = null;
        return;
      }
      const dx = e.clientX - d.sx;
      const dy = e.clientY - d.sy;
      if (Math.abs(dx) + Math.abs(dy) > 3) lightboxMoved.current = true;
      d.lx = e.clientX;
      d.ly = e.clientY;
      setLightboxOffset({ x: d.ox + dx, y: d.oy + dy });
    };
    const onUp = () => {
      const d = lightboxDrag.current;
      if (!d) return;
      // 定格到最后一次已知位置（合成的 up 事件坐标不可信）
      setLightboxOffset({ x: d.ox + (d.lx - d.sx), y: d.oy + (d.ly - d.sy) });
      lightboxDrag.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [lightbox]);

  /** 成员菜单/@提及：把 @昵称 插入草稿并登记提及，光标落回输入框 */
  const mentionFromMenu = (m: UserBrief) => {
    setSideTab('rooms');
    const el = composerRef.current;
    const pos = el?.selectionStart ?? draft.length;
    const next = draft.slice(0, pos) + `@${m.username} ` + draft.slice(pos);
    setDraft(next);
    pickedMentions.current.set(m.id, m.username);
    requestAnimationFrame(() => {
      el?.focus();
      const caret = pos + m.username.length + 2;
      el?.setSelectionRange(caret, caret);
    });
  };

  // 好友操作提示 3s 自动消退
  useEffect(() => {
    if (!friendNotice) return;
    const t = setTimeout(clearNotice, 3000);
    return () => clearTimeout(t);
  }, [friendNotice, clearNotice]);

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
          {!offline && (
            <button
              className="bell-btn"
              title="通知中心"
              onClick={() => {
                if (!showNotif) markAllRead();
                setShowNotif((v) => !v);
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                <path d="M13.73 21a2 2 0 0 1-3.46 0" />
              </svg>
              {notifUnread > 0 && <span className="tab-badge">{notifUnread > 99 ? '99+' : notifUnread}</span>}
            </button>
          )}
        </div>
        {!offline && (
          <div className="side-tabs">
            <button type="button" className={`side-tab ${sideTab === 'rooms' ? 'active' : ''}`} onClick={() => setSideTab('rooms')}>
              消息
            </button>
            <button
              type="button"
              className={`side-tab ${sideTab === 'friends' ? 'active' : ''}`}
              onClick={() => {
                setSideTab('friends');
                void loadFriends();
              }}
            >
              好友
              {friendIncoming.length > 0 && (
                <span className="tab-badge">{friendIncoming.length > 99 ? '99+' : friendIncoming.length}</span>
              )}
            </button>
          </div>
        )}
        {showNotif && !offline && (
          <NotificationPanel
            onGoRoom={(rid) => {
              setSideTab('rooms');
              void selectRoom(rid);
            }}
            onGoFriends={() => setSideTab('friends')}
            onClose={() => setShowNotif(false)}
          />
        )}
        {(offline || sideTab === 'rooms') ? (
        <>
        <div className="rooms-header">
          <span>房间</span>
          <button
            className="icon-btn"
            title={offline ? '离线模式不可创建/加入房间' : '创建/加入房间'}
            disabled={offline}
            onClick={() => {
              setRoomName('');
              setInviteCode('');
              setShowRoomModal(true);
            }}
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
            return (
              <div
                key={r.id}
                className={`room-item ${r.id === activeRoomId ? 'active' : ''}`}
                onClick={() => void selectRoom(r.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setConfirmDeleteInMenu(false);
                  setRoomMenu({
                    id: r.id,
                    invite: r.inviteCode,
                    isOwner: r.ownerId === me?.id,
                    x: Math.min(e.clientX, window.innerWidth - 190),
                    y: Math.min(e.clientY, window.innerHeight - 110),
                  });
                }}
              >
                <div
                  className="room-avatar"
                  aria-hidden
                  style={{ background: `hsl(${[...(r.name || '#')].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7)} 32% 42%)`, color: '#fff' }}
                >
                  {(r.name || '#').slice(0, 1)}
                </div>
                <div className="room-main">
                  <div className="room-line1">
                    <span className="room-name">{r.name}</span>
                    {!!unreadByRoom[r.id] && (
                      <span className="room-badge">{unreadByRoom[r.id] > 99 ? '99+' : unreadByRoom[r.id]}</span>
                    )}
                    {previewByRoom[r.id] && (
                      <span className="room-time">{formatRoomTime(previewByRoom[r.id].createdAt)}</span>
                    )}
                  </div>
                  {previewByRoom[r.id] && (
                    <div className="room-preview">
                      {previewByRoom[r.id].username}：{previewByRoom[r.id].text}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </nav>
        </>
        ) : (
        <div className="friends-panel">
          <div className="friends-add">
            <input
              value={addFriendInput}
              placeholder="输入用户名或 #ID 加好友"
              maxLength={32}
              onChange={(e) => setAddFriendInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (e.key === 'Enter' && addFriendInput.trim()) void handleAddFriend();
              }}
            />
            <button className="btn primary small" disabled={!addFriendInput.trim()} onClick={() => void handleAddFriend()}>
              加好友
            </button>
          </div>
          {friendNotice && <div className="friends-notice ok" onClick={clearNotice}>{friendNotice}</div>}
          {friendsError && <div className="friends-notice err" onClick={clearNotice}>{friendsError}</div>}
          {friendIncoming.length > 0 && (
            <div className="friends-section">
              <div className="friends-section-title">好友申请</div>
              {friendIncoming.map((r) => (
                <div key={r.id} className="friend-item request">
                  <span className="member-avatar">
                    <Avatar name={r.user.username} url={r.user.avatarUrl} size={30} />
                  </span>
                  <span className="friend-info">
                    <span className="member-name">{r.user.username}</span>
                    <span className="friend-sub">请求添加你为好友</span>
                  </span>
                  <button className="btn primary small" onClick={() => void acceptFriend(r.id)}>
                    接受
                  </button>
                  <button className="btn ghost small" onClick={() => void declineFriend(r.id)}>
                    拒绝
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="friends-list">
            {friends.length === 0 && (
              <div className="rooms-hint">
                还没有好友
                <br />
                上方输入对方用户名或 #ID 添加
              </div>
            )}
            {friends.map((f) => (
              <div
                key={f.id}
                className={`friend-item ${f.online ? 'online' : 'offline'}`}
                title={f.online ? '在线 · 查看资料' : '离线 · 查看资料'}
                onClick={() => setCardMember(f)}
              >
                <span className="member-avatar">
                  <Avatar name={f.username} url={f.avatarUrl} size={30} />
                </span>
                <span className="friend-info">
                  <span className="member-name">{f.username}</span>
                  <span className="friend-sub">{f.bio || (f.online ? '在线' : '离线')}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
        )}
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
                  void openSettingsWindow();
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
                    // 清空上一账号的房间/消息/好友，新账号登录不继承
                    useChat.getState().resetAccountState();
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
            {activeRoom && !offline ? (
              <span
                className="topbar-avatar"
                aria-hidden
                style={{ background: `hsl(${[...(activeRoom.name || '#')].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7)} 32% 42%)` }}
              >
                {(activeRoom.name || '#').slice(0, 1)}
              </span>
            ) : (
              <span className="hash">#</span>
            )}
            <span>{offline ? '离线模式' : (activeRoom?.name ?? '未选择房间')}</span>
            {activeRoom && !offline && <span className="me-tag">邀请码 {activeRoom.inviteCode}</span>}
          </div>
          <div className="topbar-right">
            {offline && <span className="offline-tag">离线模式</span>}
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
                  <span
                    className="message-avatar"
                    onContextMenu={(e) => {
                      if (offline || m.pending) return;
                      e.preventDefault();
                      e.stopPropagation();
                      const live = members.find((x) => x.id === m.userId);
                      setMemberMenu({
                        member: {
                          id: m.userId,
                          username: m.username,
                          avatarUrl: m.avatarUrl ?? null,
                          online: live?.online ?? false,
                          mutedUntil: live?.mutedUntil ?? null,
                        },
                        x: Math.min(e.clientX, window.innerWidth - 200),
                        y: Math.min(e.clientY, window.innerHeight - 300),
                        confirmKick: false,
                      });
                    }}
                  >
                    <Avatar name={m.username} url={m.avatarUrl} size={30} />
                  </span>
                  <div
                    className="message-body"
                    onContextMenu={(e) => {
                      if (offline || m.pending || m.recalled) return;
                      e.preventDefault();
                      e.stopPropagation();
                      setMsgMenu({ msg: m, x: Math.min(e.clientX, window.innerWidth - 190), y: Math.min(e.clientY, window.innerHeight - 170) });
                    }}
                  >
                    <div className="message-head">
                      <span className="message-author">{m.username}</span>
                      <span className="message-time">{m.pending ? '发送中…' : new Date(m.createdAt).toLocaleTimeString()}</span>
                    </div>
                    {m.recalled ? (
                      <div className="message-recalled">{m.userId === me?.id ? '你撤回了一条消息' : '消息已撤回'}</div>
                    ) : (
                      <>
                        {m.reply && (
                          <div className="message-quote">
                            <span className="message-quote-name">{m.reply.username}</span>
                            <span className="message-quote-text">{m.reply.kind === 'image' ? '[图片]' : m.reply.text}</span>
                          </div>
                        )}
                        {m.kind === 'image' && m.mediaUrl && (
                          <img
                            className="msg-image"
                            src={absUrl(m.mediaUrl)}
                            alt="图片"
                            loading="lazy"
                            onClick={() => {
                              if (m.mediaUrl) openLightbox(absUrl(m.mediaUrl));
                            }}
                          />
                        )}
                        {m.text && <div className="message-text">{renderMentions(m.text, m.mentions)}</div>}
                      </>
                    )}
                  </div>
                </div>
              </Fragment>
            );
          })}
        </div>

        <footer className="composer">
          {showEmoji && <div className="menu-mask" onClick={() => setShowEmoji(false)} />}
          {showEmoji && (
            <div className="emoji-pop">
              {recentEmojis.length > 0 && (
                <>
                  <div className="emoji-section">最近</div>
                  <div className="emoji-grid">
                    {recentEmojis.map((e) => (
                      <button key={`r-${e}`} type="button" className="emoji-cell" onMouseDown={(ev) => { ev.preventDefault(); insertEmoji(e); }}>
                        {e}
                      </button>
                    ))}
                  </div>
                </>
              )}
              <div className="emoji-section">全部</div>
              <div className="emoji-grid">
                {EMOJIS.map((e) => (
                  <button key={e} type="button" className="emoji-cell" onMouseDown={(ev) => { ev.preventDefault(); insertEmoji(e); }}>
                    {e}
                  </button>
                ))}
              </div>
            </div>
          )}
          {mentionQuery && mentionCandidates.length > 0 && (
            <div className="mention-pop">
              {mentionCandidates.map((m, i) => (
                <button
                  key={m.id}
                  type="button"
                  className={`mention-item ${i === mentionPick ? 'active' : ''}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    applyMentionPick(m);
                  }}
                  onMouseEnter={() => setMentionPick(i)}
                >
                  <Avatar name={m.username} url={m.avatarUrl} size={20} />
                  <span>{m.username}</span>
                  {!m.online && <span className="mention-off">离线</span>}
                </button>
              ))}
            </div>
          )}
          {pendingImage && (
            <div className="attachment-bar">
              <img className="attachment-thumb" src={absUrl(pendingImage)} alt="待发送图片" />
              <span className="attachment-name">图片已上传，可配文字后发送</span>
              <button className="attachment-remove" title="移除图片" onClick={() => setPendingImage(null)}>
                ×
              </button>
            </div>
          )}
          {replyTo && (
            <div className="reply-bar">
              <span className="reply-label">回复 {replyTo.username}</span>
              <span className="reply-snippet">{replyTo.kind === 'image' ? '[图片]' : replyTo.recalled ? '消息已撤回' : replyTo.text}</span>
              <button className="attachment-remove" title="取消引用" onClick={() => setReplyTo(null)}>
                ×
              </button>
            </div>
          )}
          <div className="composer-row">
          <button
            className="composer-icon"
            title={uploading ? '图片上传中…' : '发送图片'}
            disabled={offline || !connected || !activeRoom || uploading}
            onClick={() => imageInputRef.current?.click()}
          >
            {uploading ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <path d="M21 15l-5-5L5 21" />
              </svg>
            )}
          </button>
          <input
            ref={imageInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            style={{ display: 'none' }}
            onChange={(e) => {
              void onPickImageFile(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
          <button
            className="composer-icon"
            title="表情"
            disabled={offline || !connected || !activeRoom}
            onClick={() => setShowEmoji((v) => !v)}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <path d="M8 14s1.5 2 4 2 4-2 4-2" />
              <line x1="9" y1="9" x2="9.01" y2="9" />
              <line x1="15" y1="9" x2="15.01" y2="9" />
            </svg>
          </button>
          <input
            ref={composerRef}
            className="composer-input"
            value={draft}
            placeholder={offline ? '离线模式：未连接服务器' : connected ? (activeRoom ? '输入消息，Enter 发送，@ 唤起提及' : '先选择或创建房间') : '未连接'}
            disabled={offline || !connected || !activeRoom}
            maxLength={2000}
            onChange={(e) => {
              const v = e.target.value;
              setDraft(v);
              const caret = e.target.selectionStart ?? v.length;
              const m = /@([\w\u4e00-\u9fa5-]{0,24})$/.exec(v.slice(0, caret));
              if (m && !offline && connected) {
                setMentionQuery({ start: m.index, token: m[1] ?? '', caret });
                setMentionPick(0);
              } else {
                setMentionQuery(null);
              }
            }}
            onKeyDown={(e) => {
              // 中文输入法组词期间的 Enter 是确认候选词，不是发送（keyCode 229 为组词键事件兜底）
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (mentionQuery && mentionCandidates.length > 0) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setMentionPick((p) => (p + 1) % mentionCandidates.length);
                  return;
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setMentionPick((p) => (p - 1 + mentionCandidates.length) % mentionCandidates.length);
                  return;
                }
                if (e.key === 'Enter') {
                  e.preventDefault();
                  applyMentionPick(mentionCandidates[mentionPick]);
                  return;
                }
                if (e.key === 'Escape') {
                  setMentionQuery(null);
                  return;
                }
              }
              if (e.key === 'Enter' && !e.shiftKey && !offline && connected && activeRoom) {
                e.preventDefault();
                sendDraft();
              }
            }}
          />
          <button className="btn primary" disabled={offline || !connected || !activeRoom || (!draft.trim() && !pendingImage)} onClick={sendDraft}>
            发送
          </button>
          {activeRoom && (
            <button className="btn ghost" title="离开房间" onClick={() => void leaveActiveRoom()}>
              离开
            </button>
          )}
          </div>
        </footer>

        <footer className="status-bar">
          <button className="status-item" title="在设置中管理" onClick={() => void openSettingsWindow()}>
            游戏模式 {offline ? '未登录' : gameModeEnabled ? `已开启 · ${hotkey}` : '已关闭'}
          </button>
          <button className="status-item" title="在设置中管理" onClick={() => void openSettingsWindow()}>
            提示音 {soundEnabled ? '已开启' : '已关闭'}
          </button>
        </footer>
      </main>

      {/* 成员面板（QQ 式花名册）：离线成员置灰保留 + 房主标注 + 房主管理 */}
      {!offline && activeRoom && (
        <aside className="members-panel">
          <div className="members-header">
            <span>成员</span>
            <span className="members-count" title="在线 / 总成员">
              {onlineCount}/{members.length}
            </span>
          </div>
          <div className="members-list">
            {roster.map((m) => {
              const isOwner = m.id === activeRoom.ownerId;
              const isSelf = m.id === me?.id;
              return (
                <div
                  key={m.id}
                  className={`member-item ${isSelf ? 'self' : ''} ${m.online ? 'online' : 'offline'}`}
                  title={m.online ? '在线 · 查看资料' : '离线 · 查看资料'}
                  onClick={() => setCardMember(m)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMemberMenu({
                      member: m,
                      x: Math.min(e.clientX, window.innerWidth - 200),
                      y: Math.min(e.clientY, window.innerHeight - 300),
                      confirmKick: false,
                    });
                  }}
                >
                  <span className="member-avatar">
                    <Avatar name={m.username} url={m.avatarUrl} size={26} />
                  </span>
                  <span className="member-name">
                    {m.username}
                    {isSelf ? '（我）' : ''}
                  </span>
                  {m.mutedUntil && new Date(m.mutedUntil) > new Date() && (
                    <span className="mute-chip" title={`禁言至 ${new Date(m.mutedUntil).toLocaleTimeString()}`}>
                      禁言
                    </span>
                  )}
                  {isOwner && (
                    <span className="owner-chip" title="房主">
                      房主
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </aside>
      )}

      {roomMenu && (
        <>
          <div className="menu-mask" onClick={() => setRoomMenu(null)} />
          <CtxMenu x={roomMenu.x} y={roomMenu.y}>
            <button
              className="ctx-menu-item"
              onClick={async () => {
                await copyText(roomMenu.invite);
                setRoomMenu(null);
              }}
            >
              复制邀请码
            </button>
            {roomMenu.isOwner && (
              <button
                className="ctx-menu-item danger"
                onClick={() => {
                  if (!confirmDeleteInMenu) {
                    setConfirmDeleteInMenu(true);
                    return;
                  }
                  deleteRoom(roomMenu.id);
                  setRoomMenu(null);
                }}
              >
                {confirmDeleteInMenu ? '确认删除？' : '删除房间'}
              </button>
            )}
          </CtxMenu>
        </>
      )}
      {memberMenu && activeRoom && (
        <>
          <div className="menu-mask" onClick={() => setMemberMenu(null)} />
          <CtxMenu x={memberMenu.x} y={memberMenu.y}>
            <div className="ctx-menu-title">{memberMenu.member.username}</div>
            {memberMenu.member.id !== me?.id && (
              <button
                className="ctx-menu-item"
                onClick={() => {
                  mentionFromMenu(memberMenu.member);
                  setMemberMenu(null);
                }}
              >
                @ 提及
              </button>
            )}
            {memberMenu.member.id !== me?.id && relationOf(memberMenu.member.id) === 'none' && (
              <button
                className="ctx-menu-item"
                onClick={() => {
                  void sendRequest(memberMenu.member.id);
                  setMemberMenu(null);
                }}
              >
                添加好友
              </button>
            )}
            {memberMenu.member.id !== me?.id && relationOf(memberMenu.member.id) === 'pending' && (
              <div className="ctx-menu-item disabled">好友申请处理中</div>
            )}
            <button
              className="ctx-menu-item"
              onClick={() => {
                setCardMember(memberMenu.member);
                setMemberMenu(null);
              }}
            >
              查看资料
            </button>
            {activeRoom.ownerId === me?.id && memberMenu.member.id !== me?.id && (
              memberMenu.member.mutedUntil && new Date(memberMenu.member.mutedUntil) > new Date() ? (
                <button
                  className="ctx-menu-item danger"
                  onClick={() => {
                    unmuteMember(activeRoom.id, memberMenu.member.id);
                    setMemberMenu(null);
                  }}
                >
                  解除禁言
                </button>
              ) : (
                <>
                  <div className="ctx-menu-title small">禁言</div>
                  {[
                    [10, '10 分钟'],
                    [60, '1 小时'],
                    [1440, '1 天'],
                  ].map(([min, label]) => (
                    <button
                      key={min}
                      className="ctx-menu-item"
                      onClick={() => {
                        muteMember(activeRoom.id, memberMenu.member.id, min as number);
                        setMemberMenu(null);
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </>
              )
            )}
            {activeRoom.ownerId === me?.id &&
              memberMenu.member.id !== me?.id &&
              memberMenu.member.id !== activeRoom.ownerId && (
                <button
                  className={`ctx-menu-item danger ${memberMenu.confirmKick ? 'confirming' : ''}`}
                  onClick={() => {
                    if (!memberMenu.confirmKick) {
                      setMemberMenu({ ...memberMenu, confirmKick: true });
                      return;
                    }
                    kickMember(activeRoom.id, memberMenu.member.id);
                    setMemberMenu(null);
                  }}
                >
                  {memberMenu.confirmKick ? '确认移出？' : '移出房间'}
                </button>
              )}
          </CtxMenu>
        </>
      )}
      {msgMenu && activeRoom && (
        <>
          <div className="menu-mask" onClick={() => setMsgMenu(null)} />
          <CtxMenu x={msgMenu.x} y={msgMenu.y}>
            {!!msgMenu.msg.text && (
              <button
                className="ctx-menu-item"
                onClick={() => {
                  void copyText(msgMenu.msg.text);
                  setMsgMenu(null);
                }}
              >
                复制
              </button>
            )}
            {msgMenu.msg.kind === 'image' && msgMenu.msg.mediaUrl && (
              <button
                className="ctx-menu-item"
                onClick={() => {
                  void copyImageToClipboard(absUrl(msgMenu.msg.mediaUrl!));
                  setMsgMenu(null);
                }}
              >
                复制图片
              </button>
            )}
            <button
              className="ctx-menu-item"
              onClick={() => {
                setReplyTo(msgMenu.msg);
                setMsgMenu(null);
              }}
            >
              引用
            </button>
            {(msgMenu.msg.userId === me?.id || activeRoom.ownerId === me?.id) && !msgMenu.msg.pending && (
              <button
                className="ctx-menu-item danger"
                onClick={() => {
                  recallMessage(activeRoom.id, msgMenu.msg.id);
                  setMsgMenu(null);
                }}
              >
                {msgMenu.msg.userId === me?.id ? '撤回' : '撤回（房主）'}
              </button>
            )}
          </CtxMenu>
        </>
      )}
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
          friendStatus={relationOf(cardMember.id)}
          onAddFriend={() => void sendRequest(cardMember.id)}
          onRemoveFriend={() => {
            void removeFriendById(cardMember.id);
            setCardMember(null);
          }}
          onClose={() => setCardMember(null)}
        />
      )}
      {/* 好友卡片：从好友列表点开（无房间上下文） */}
      {cardMember && !activeRoom && !offline && (
        <MemberCardModal
          member={cardMember}
          isOwner={false}
          canKick={false}
          onKick={() => undefined}
          friendStatus={relationOf(cardMember.id)}
          onAddFriend={() => void sendRequest(cardMember.id)}
          onRemoveFriend={() => {
            void removeFriendById(cardMember.id);
            setCardMember(null);
          }}
          onClose={() => setCardMember(null)}
        />
      )}

      {lightbox && (
        <div
          className="modal-mask lightbox"
          onClick={() => {
            // 拖拽平移结束的那次点击不关闭灯箱
            if (lightboxMoved.current) {
              lightboxMoved.current = false;
              return;
            }
            setLightbox(null);
          }}
          onWheel={(e) => {
            setLightboxZoom((z) => Math.min(8, Math.max(0.2, z * (e.deltaY < 0 ? 1.15 : 1 / 1.15))));
          }}
          onMouseDown={(e) => {
            if (lightboxZoom <= 1) return;
            // 拖拽用 window 级 mouse 监听（组件挂载期注册）：松手必停
            lightboxDrag.current = { id: 0, sx: e.clientX, sy: e.clientY, ox: lightboxOffset.x, oy: lightboxOffset.y, lx: e.clientX, ly: e.clientY };
            lightboxMoved.current = false;
          }}
        >
          <img
            src={lightbox}
            alt="图片预览"
            draggable={false}
            // 阻止原生图片拖拽：浏览器接管后 move 事件停发（指针变禁止、松手才更新位置）
            onDragStart={(e) => e.preventDefault()}
            style={{ transform: `translate(${lightboxOffset.x}px, ${lightboxOffset.y}px) scale(${lightboxZoom})`, cursor: lightboxZoom > 1 ? 'grab' : 'zoom-out' }}
            onClick={(e) => e.stopPropagation()}
          />
          <div className="lightbox-toolbar" onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
            <button title="缩小" onClick={() => setLightboxZoom((z) => Math.max(0.2, z / 1.25))}>
              −
            </button>
            <span className="lightbox-zoom">{Math.round(lightboxZoom * 100)}%</span>
            <button title="放大" onClick={() => setLightboxZoom((z) => Math.min(8, z * 1.25))}>
              ＋
            </button>
            <button
              title="原始大小"
              onClick={() => {
                setLightboxZoom(1);
                setLightboxOffset({ x: 0, y: 0 });
              }}
            >
              1:1
            </button>
            <button title="保存图片" onClick={() => void saveLightboxImage(lightbox)}>
              保存
            </button>
          </div>
          <button className="lightbox-close" title="关闭" onClick={() => setLightbox(null)}>
            ×
          </button>
        </div>
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
