import { Fragment, useLayoutEffect, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useChat } from './stores/chat';
import { useFriends } from './stores/friends';
import * as api from './app/api';
import type { MentionRef, RoomMember, UserBrief } from './app/types';
import type { RoomMessage } from './app/api';
import { useAuth } from './stores/auth';
import { useSettings, applyProxySetting, type OverlayPosition } from './app/settings';
import * as gameMode from './app/gameMode';
import appIcon from './assets/app-icon.png';

/** deep link 邀请码中转键：根组件收到 gametalk:// 链接后落盘，ChatView（登录后）读取弹确认 */
const PENDING_INVITE_KEY = 'gametalk_pending_invite';

/**
 * 广播里的资源绝对 URL 由服务器按请求 Host 推导——恶意客户端可伪造 Host 把
 * 头像/图片地址指到自己的域（受害者加载时泄漏 IP、可注入图片内容）。
 * 这里统一重写为本端配置的 serverUrl：只要 path 是本服务端点，域名一律不信。
 */
function normalizeResourceUrl(u: string | null | undefined): string {
  if (!u) return '';
  const m = /^https?:\/\/[^/]+(\/api\/.+)$/.exec(u);
  if (m) return useSettings.getState().serverUrl.replace(/\/+$/, '') + m[1];
  return u;
}

function Avatar({ name, url, size = 28 }: { name: string; url?: string | null; size?: number }) {
  if (url) {
    return (
      <img
        className="avatar-img"
        src={normalizeResourceUrl(url)}
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

/** 撤回行文案：代撤（操作者≠作者）一律带出被撤人——自己代撤「你撤回了 XX 的消息」，房主代撤「房主撤回了 XX 的消息」；作者自己撤「你/XX撤回了一条消息」 */
function recallLineOf(m: { userId: string; username: string; recalledBy?: { id: string; username: string } }, meId?: string): string {  const op = m.recalledBy ?? { id: m.userId, username: m.username };
  if (op.id !== m.userId) {
    return op.id === meId ? `你撤回了 ${m.username} 的消息` : `${op.username}撤回了 ${m.username} 的消息`;
  }
  if (meId && op.id === meId) return '你撤回了一条消息';
  return `${op.username}撤回了一条消息`;
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

/** 自定义表情包：按账号存储 media URL 列表（GIF/图片，点击即作为图片消息发送） */
const MAX_STICKERS = 24;

function loadStickers(userId: string): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(`gt-stickers#${userId}`) ?? '[]');
    return Array.isArray(list) ? list.filter((e) => typeof e === 'string').slice(0, MAX_STICKERS) : [];
  } catch {
    return [];
  }
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
  // 长名优先匹配：否则 @Alice2 会被短名 @Alice 截断成「@Alice + 2」
  names.sort((a, b) => b.length - a.length);
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

/** 打开独立设置窗口（Tauri 运行时创建；浏览器调试回退为普通标签页）。
 *  section：可选初始分类；窗口已存在时发导航事件而不是重建 */
async function openSettingsWindow(section?: 'general' | 'notify' | 'game' | 'overlay' | 'about'): Promise<void> {
  const { emit } = await import('@tauri-apps/api/event');
  const existing = await import('@tauri-apps/api/webviewWindow')
    .then(({ WebviewWindow }) => WebviewWindow.getByLabel('settings'))
    .catch(() => null);
  if (existing) {
    if (section) void emit('settings:navigate', { section }).catch(() => undefined);
    void existing.show();
    void existing.setFocus();
    return;
  }
  try {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    const win = new WebviewWindow('settings', {
      title: 'GameTalk 设置',
      url: section ? `settings.html?section=${section}` : 'settings.html',
      width: 820,
      height: 600,
      minWidth: 720,
      minHeight: 520,
      center: true,
      resizable: true,
    });
    // 关闭设置窗口时立即收起屏幕覆盖预览（不等待自然超时，避免预览挂在游戏画面上）
    void win.once('tauri://destroyed', () => {
      void import('@tauri-apps/api/event').then(({ emit }) => emit('overlay:hide'));
    });
  } catch {
    window.open(section ? `settings.html?section=${section}` : 'settings.html', '_blank');
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

/** 成员卡片：点击成员查看公开资料；房主可移出；可加/删好友 */
function MemberCardModal({
  member,
  isOwner,
  canKick,
  onKick,
  friendStatus,
  onAddFriend,
  onRemoveFriend,
  onMessage,
  onClose,
}: {
  member: UserBrief;
  isOwner: boolean;
  canKick: boolean;
  onKick: () => void;
  friendStatus?: 'self' | 'friends' | 'pending' | 'none';
  onAddFriend?: () => void;
  onRemoveFriend?: () => void;
  onMessage?: () => void;
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
    return () => {
      if (kickTimer.current) clearTimeout(kickTimer.current);
      if (removeTimer.current) clearTimeout(removeTimer.current);
    };
  }, []);

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
        {friendStatus === 'friends' && onMessage && (
          <button className="btn primary block" onClick={onMessage}>
            发消息
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

/** 好友资料页（QQ 式，主区域展示）：大头像 / 昵称 / 在线 / ID 复制 / 签名 / 注册时间 / 发消息 / 删除好友 */
function FriendProfilePane({
  friend,
  onMessage,
  onRemove,
  onClose,
}: {
  friend: api.Friend;
  onMessage: () => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const { token } = useAuth();
  const [profile, setProfile] = useState<api.MemberProfile | null>(null);
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [copied, setCopied] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    if (token) {
      api
        .getUserProfile(token, friend.id)
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
  }, [token, friend.id, reloadKey]);

  const handleRemove = () => {
    if (!confirmRemove) {
      setConfirmRemove(true);
      timer.current = setTimeout(() => setConfirmRemove(false), 3000);
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    onRemove();
    onClose();
  };

  return (
    <div className="friend-profile-pane">
      <div className="fpp-card">
        <div className="fpp-hero">
          <Avatar name={friend.username} url={profile?.avatarUrl ?? friend.avatarUrl} size={72} />
          <div className="fpp-hero-main">
            <div className="fpp-name">
              {friend.username}
              <span className={`dm-online-tag ${friend.online ? 'ok' : ''}`}>{friend.online ? '在线' : '离线'}</span>
            </div>
            <button
              className="id-row"
              title="点击复制 ID"
              onClick={async () => {
                if (await copyText(friend.id)) {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }
              }}
            >
              <span className="user-id">#{friend.id.slice(0, 8)}</span>
              <span className="id-copy">{copied ? '已复制 ✓' : '复制 ID'}</span>
            </button>
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
            profile?.bio || friend.bio || '这个人很神秘，什么都没有写'
          )}
        </div>
        {profile && <div className="card-meta">注册于 {new Date(profile.createdAt).toLocaleDateString()}</div>}
        <div className="fpp-actions">
          <button className="btn primary" onClick={onMessage}>
            发消息
          </button>
          <button className={`btn ghost danger ${confirmRemove ? 'confirming' : ''}`} onClick={handleRemove}>
            {confirmRemove ? '确认删除好友？' : '删除好友'}
          </button>
        </div>
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
    dmMessages,
    dmHistoryLoaded,
    dmHasMore,
    dmUnread,
    dmPreviews,
    activeDmPeerId,
    openDm,
    loadOlderDmMessages,
    sendDm,
    recallDm,
    editMessage,
    editDm,
  } = useChat();
  const { user, logout } = useAuth();
  const { gameModeEnabled, hotkey, soundEnabled, notifyLevel } = useSettings();
  /** 快捷输入框的独立发送目标（null = 跟随主窗口当前会话；呼出时重置） */
  const gameTargetRef = useRef<gameMode.InputTarget | null>(null);
  // 输入草稿按会话（房间/私聊）独立保存：切换会话互不串扰，回来还在
  const [draftMap, setDraftMap] = useState<Record<string, string>>({});
  const convKey = activeDmPeerId ? `dm:${activeDmPeerId}` : `room:${activeRoomId ?? 'none'}`;
  const draft = draftMap[convKey] ?? '';
  const setDraft = (v: string) => setDraftMap((m) => ({ ...m, [convKey]: v }));
  const [roomMenu, setRoomMenu] = useState<{ id: string; invite: string; isOwner: boolean; x: number; y: number } | null>(null);
  const [confirmDeleteInMenu, setConfirmDeleteInMenu] = useState(false);
  /** 成员右键菜单：目标成员 + 位置（@提及 / 加好友 / 房主管理） */
  const [memberMenu, setMemberMenu] = useState<{ member: RoomMember; x: number; y: number; confirmKick: boolean } | null>(null);
  /** 消息右键菜单：复制 / 引用 / 撤回 */
  const [msgMenu, setMsgMenu] = useState<{ msg: RoomMessage; x: number; y: number } | null>(null);
  /** 左下角头像二级菜单（个人资料 / 设置 / 退出登录） */
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  /** 成员卡片：当前查看的成员 + 打开来源（房间上下文才有「移出房间」，好友来源永不显示） */
  const [cardMember, setCardMember] = useState<{ member: UserBrief; from: 'room' | 'friend' } | null>(null);
  /** 好友右键菜单：查看资料 / 删除好友（二次确认） */
  const [friendMenu, setFriendMenu] = useState<{ friend: api.Friend; x: number; y: number; confirmRemove: boolean } | null>(null);
  /** 私聊消息头像右键菜单：查看资料 / 删除好友（二次确认） */
  const [dmMsgMenu, setDmMsgMenu] = useState<{ member: UserBrief; x: number; y: number; confirmRemove: boolean } | null>(null);
  /** 转发选择器：待转发的消息 + 来源会话类型（目标 = 我的房间列表 ∪ 好友私聊） */
  const [forwardPicker, setForwardPicker] = useState<{ msg: RoomMessage; source: 'room' | 'dm' } | null>(null);
  /** 邀请链接管理面板：目标房间 */
  const [invitePanelRoom, setInvitePanelRoom] = useState<api.Room | null>(null);
  /** deep link 邀请：待预览确认的邀请码（gametalk://join?code=xxx） */
  const [pendingInvite, setPendingInvite] = useState<string | null>(null);
  const [showRoomModal, setShowRoomModal] = useState(false);
  const [roomName, setRoomName] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  /** 侧栏双 Tab（QQ 式）：消息=房间列表 / 好友=好友管理 */
  const [sideTab, setSideTab] = useState<'rooms' | 'friends'>('rooms');
  const [addFriendInput, setAddFriendInput] = useState('');
  /** 好友 Tab：选中的好友（主区域显示 QQ 式资料页）与「添加好友」折叠态 */
  const [selectedFriendId, setSelectedFriendId] = useState<string | null>(null);
  const [showAddFriend, setShowAddFriend] = useState(false);
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
  /** 云端表情包（个人 / 当前房间共享），跨设备同步 */
  const [myStickers, setMyStickers] = useState<api.StickerItem[]>([]);
  const [roomStickers, setRoomStickers] = useState<api.StickerItem[]>([]);
  const [stickerBusy, setStickerBusy] = useState(false);
  const [emojiTab, setEmojiTab] = useState<'emoji' | 'mine' | 'room'>('emoji');
  const stickerInputRef = useRef<HTMLInputElement>(null);
  const [stickerUploading, setStickerUploading] = useState(false);
  // 换账号后重读该账号的常用表情
  useEffect(() => {
    setRecentEmojis(loadRecentEmojis(emojiOwner));
  }, [emojiOwner]);

  // 云表情包：打开面板或切换目标房间时刷新；首次发现本地旧表情包则自动迁移到云端
  const loadCloudStickers = async () => {
    const { token } = useAuth.getState();
    if (!token || offline) return;
    setStickerBusy(true);
    try {
      const { stickers } = await api.listStickers(token);
      // 本地旧表情包迁移：云端为空且本地有 → 把本地上传过的媒体逐个登记到云端
      const legacy = loadStickers(emojiOwner);
      if (stickers.length === 0 && legacy.length > 0) {
        const migrated: api.StickerItem[] = [];
        for (const url of legacy) {
          const mediaId = /api\/media\/([0-9a-f-]{36})/.exec(url)?.[1];
          if (!mediaId) continue;
          try {
            const { sticker } = await api.addSticker(token, mediaId);
            migrated.push(sticker);
          } catch {
            // 单个迁移失败不阻塞其余（媒体可能已过期）
          }
        }
        setMyStickers(migrated);
        if (migrated.length > 0) {
          try {
            localStorage.removeItem(`gt-stickers#${emojiOwner}`);
          } catch {
            // 忽略
          }
        }
        return;
      }
      setMyStickers(stickers);
      if (activeRoomId) {
        try {
          const rs = await api.listRoomStickers(token, activeRoomId);
          setRoomStickers(rs.stickers);
        } catch {
          setRoomStickers([]);
        }
      } else {
        setRoomStickers([]);
      }
    } catch {
      // 拉取失败保留现状（下次打开面板重试）
    } finally {
      setStickerBusy(false);
    }
  };

  useEffect(() => {
    if (showEmoji) void loadCloudStickers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showEmoji, activeRoomId, emojiOwner]);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [lightboxZoom, setLightboxZoom] = useState(1);
  const [lightboxOffset, setLightboxOffset] = useState({ x: 0, y: 0 });
  const lightboxImgRef = useRef<HTMLImageElement | null>(null);
  const lightboxDrag = useRef<{ id: number; sx: number; sy: number; ox: number; oy: number; lx: number; ly: number } | null>(null);
  const lightboxMoved = useRef(false);
  const imageInputRef = useRef<HTMLInputElement>(null);
  /** 待发送图片附件：上传完成后先挂起，可配文字，手动发送 */
  const [pendingImage, setPendingImage] = useState<string | null>(null);
  /** 引用回复：待回复的原消息（发送后气泡内渲染引用块） */
  const [replyTo, setReplyTo] = useState<RoomMessage | null>(null);
  /** 编辑消息：正在编辑的自己的消息（composer 变编辑模式，Enter 提交 / Esc 取消） */
  const [editingMsg, setEditingMsg] = useState<RoomMessage | null>(null);
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
  /** 滚动 effect 的会话键基准：切换会话时区分「内容替换」与「新消息追加」 */
  const convKeyRef = useRef<string | null>(null);
  const connected = status === 'open';

  /** 深链邀请：登录进入聊天页时读取中转的邀请码；运行期新链接经根组件派发自定义事件后再读 */
  useEffect(() => {
    const consume = () => {
      try {
        const saved = localStorage.getItem(PENDING_INVITE_KEY);
        if (saved) setPendingInvite(saved);
      } catch {
        // localStorage 不可用（隐私模式等）：跳过中转
      }
    };
    consume();
    window.addEventListener('gametalk-invite', consume);
    return () => window.removeEventListener('gametalk-invite', consume);
  }, []);
  const activeRoom = rooms.find((r) => r.id === activeRoomId) ?? null;
  // 活跃会话二选一：DM（好友私聊）优先于房间；DM 时消息/顶栏/成员面板均切换
  const activeDm = activeDmPeerId ? (friends.find((f) => f.id === activeDmPeerId) ?? null) : null;
  const dmMessagesList = activeDmPeerId ? (dmMessages[activeDmPeerId] ?? []) : [];
  const messages = activeDm ? dmMessagesList : activeRoomId ? (messagesByRoom[activeRoomId] ?? []) : [];
  const members = activeRoomId ? (membersByRoom[activeRoomId] ?? []) : [];
  // 花名册排序：自己 → 房主 → 在线 → 离线（QQ 式）；同级按昵称稳定排序
  const memberRank = (id: string, online: boolean) => (id === me?.id ? 0 : id === activeRoom?.ownerId ? 1 : online ? 2 : 3);
  const roster = [...members].sort(
    (a, b) => memberRank(a.id, a.online) - memberRank(b.id, b.online) || a.username.localeCompare(b.username),
  );
  const onlineCount = members.filter((m) => m.online).length;
  const activeSubscribed = !!activeRoomId && subscribedRoomIds.includes(activeRoomId);
  const selectedFriend = selectedFriendId ? (friends.find((f) => f.id === selectedFriendId) ?? null) : null;
  // 侧栏私聊会话：仅好友（删好友即隐藏会话）；有预览或正在会话才显示，按最后消息时间倒序
  const dmSidebar = friends
    .filter((f) => dmPreviews[f.id] || f.id === activeDmPeerId)
    .map((f) => ({ friend: f, preview: dmPreviews[f.id] }))
    .sort((a, b) => (b.preview?.createdAt ?? '').localeCompare(a.preview?.createdAt ?? ''));
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

  const submitEdit = () => {
    if (!editingMsg || !draft.trim()) return;
    if (activeDm) editDm(editingMsg.id, draft);
    else if (activeRoom) editMessage(activeRoom.id, editingMsg.id, draft);
    setEditingMsg(null);
    setPendingImage(null);
    setDraft('');
  };

  const cancelEdit = () => {
    setEditingMsg(null);
    // 恢复进入编辑前的草稿（编辑前打了一半的消息不该被吞掉）
    setDraft(editStashRef.current ?? '');
    editStashRef.current = null;
  };

  /** 进入编辑前暂存的用户草稿（取消编辑时恢复，避免打了一半的消息被吞） */
  const editStashRef = useRef<string | null>(null);

  const startEdit = (m: RoomMessage) => {
    setReplyTo(null);
    setPendingImage(null);
    editStashRef.current = draftMap[convKey] ?? '';
    setEditingMsg(m);
    setDraft(m.text);
    requestAnimationFrame(() => {
      const el = composerRef.current;
      const len = m.text.length;
      el?.focus();
      el?.setSelectionRange(len, len);
    });
  };

  const sendDraft = () => {
    // 编辑模式：Enter/发送按钮提交编辑而非发送新消息
    if (editingMsg) {
      submitEdit();
      return;
    }
    // DM 会话：无提及语义，图片/引用照常
    if (activeDm) {
      if (!draft.trim() && !pendingImage) return;
      sendDm(draft.trim(), {
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
      setDraft('');
      setPendingImage(null);
      setReplyTo(null);
      return;
    }
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

  // 媒体 URL：相对路径拼 serverUrl；广播来的绝对 URL 一律重写到本端配置的服务器（防伪造 Host）
  const absUrl = (u: string) => {
    const n = normalizeResourceUrl(u);
    return n.startsWith('http') ? n : useSettings.getState().serverUrl.replace(/\/+$/, '') + n;
  };

  const onPickImageFile = async (file: File | undefined) => {
    if (!file || offline || !connected || (!activeRoom && !activeDm)) return;
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

  // 平移夹取：任意缩放下图片至少留 ~80px 在视口内（缩小后图片不会完全跑出预览窗口）
  const clampLightboxOffset = (z: number, off: { x: number; y: number }) => {
    const img = lightboxImgRef.current;
    if (!img) return off;
    const halfW = (img.clientWidth * z) / 2;
    const halfH = (img.clientHeight * z) / 2;
    const limX = Math.max(window.innerWidth / 2 + halfW - 80, 0);
    const limY = Math.max(window.innerHeight / 2 + halfH - 80, 0);
    return {
      x: Math.min(Math.max(off.x, -limX), limX),
      y: Math.min(Math.max(off.y, -limY), limY),
    };
  };

  /** 缩放到指定倍数并把平移位置夹回可视范围（滚轮 / ±按钮共用） */
  const zoomLightboxTo = (next: number) => {
    const z = Math.min(8, Math.max(0.2, next));
    setLightboxZoom(z);
    setLightboxOffset((off) => clampLightboxOffset(z, off));
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

  // 添加自定义表情包：上传到媒体库并记入本人表情包列表（上限 24 个）
  const onPickStickerFile = async (file: File | undefined) => {
    if (!file || offline || !connected) return;
    setStickerUploading(true);
    try {
      const { token } = useAuth.getState();
      if (!token) return;
      const dataUrl = await fileToCompressedDataUrl(file);
      const { url } = await api.uploadImage(token, dataUrl);
      const mediaId = /api\/media\/([0-9a-f-]{36})$/.exec(url)?.[1];
      if (!mediaId) throw new Error('媒体上传结果异常');
      if (emojiTab === 'room' && activeRoomId) {
        const { sticker } = await api.addRoomSticker(token, activeRoomId, mediaId);
        setRoomStickers((prev) => [...prev, sticker]);
      } else {
        const { sticker } = await api.addSticker(token, mediaId);
        setMyStickers((prev) => [...prev, sticker]);
      }
    } catch (e) {
      useChat.setState({ roomError: e instanceof Error ? e.message : '表情包添加失败' });
    } finally {
      setStickerUploading(false);
    }
  };

  // 删除表情包（个人：仅本人；群：添加者本人或房主）
  const removeSticker = async (sticker: api.StickerItem, scope: 'mine' | 'room') => {
    const { token } = useAuth.getState();
    if (!token) return;
    try {
      if (scope === 'mine') await api.deleteSticker(token, sticker.id);
      else if (activeRoomId) await api.deleteRoomSticker(token, activeRoomId, sticker.id);
      if (scope === 'mine') setMyStickers((prev) => prev.filter((x) => x.id !== sticker.id));
      else setRoomStickers((prev) => prev.filter((x) => x.id !== sticker.id));
    } catch (e) {
      useChat.setState({ roomError: e instanceof Error ? e.message : '表情包删除失败' });
    }
  };

  // 发送表情包：作为图片消息直接发出（GIF 原样保留动画）；按 mediaId 构造服务端校验的相对路径
  const sendSticker = (mediaId: string) => {
    if (offline || !connected || (!activeRoom && !activeDm)) return;
    setShowEmoji(false);
    const mediaUrl = `/api/media/${mediaId}`;
    if (activeDm) sendDm('', { mediaUrl });
    else sendMessage('', { mediaUrl });
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
    // 会话切换后列表内容整体替换：无条件滚到底
    if (convKeyRef.current !== convKey) {
      convKeyRef.current = convKey;
      el.scrollTo({ top: el.scrollHeight });
      return;
    }
    // 新消息到达：仅当本来就在底部附近（或最后一条是自己发的）才跟随滚动，读历史时不打扰
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    const lastMine = messages[messages.length - 1]?.userId === me?.id;
    if (nearBottom || lastMine) el.scrollTo({ top: el.scrollHeight });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRoomId, activeDmPeerId, messages.length]);

  const handleLoadOlder = async () => {
    if (!listRef.current) return;
    if (activeDm && activeDmPeerId) {
      anchorRef.current = listRef.current.scrollHeight;
      const before = dmMessagesList.length;
      await loadOlderDmMessages(activeDmPeerId);
      if ((useChat.getState().dmMessages[activeDmPeerId] ?? []).length === before) {
        anchorRef.current = null;
      }
      return;
    }
    if (!activeRoom) return;
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
        case 'notifyLevel':
          s.setNotifyLevel(value as 'all' | 'mention' | 'none');
          break;
        case 'gameModeEnabled':
          s.setGameModeEnabled(!!value);
          break;
        case 'hotkey':
          s.setHotkey(String(value));
          if (s.gameModeEnabled) void gameMode.reapplyHotkey();
          break;
        case 'overlayEnabled':
          s.setOverlayEnabled(!!value);
          break;
        case 'overlayPosition':
          s.setOverlayPosition(value as OverlayPosition);
          // 自定义 = 进入拖拽调整模式，由紧随的 adjust 事件接管，不执行应用+预览
          if (value === 'custom') break;
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
      const st = useChat.getState();
      // 快捷输入框有独立目标（用户点选过）→ 按目标发送且不扰动主窗口；否则跟随主窗口当前会话
      const t = gameTargetRef.current;
      if (t?.kind === 'dm') st.sendDm(text, undefined, t.id);
      else if (t?.kind === 'room') st.sendMessage(text, undefined, t.id);
      else if (st.activeDmPeerId) st.sendDm(text);
      else st.sendMessage(text);
    });
    // 快捷输入框的发送目标：全部房间 ∪ 全部好友私聊。目标独立于主窗口会话——
    // 点选只改 gameTarget（不影响主窗口正在看的会话）；每次呼出重置为主窗口当前会话
    const buildGameTargets = (): gameMode.InputTargetContext => {
      const st = useChat.getState();
      const friends = useFriends.getState().friends;
      const targets: gameMode.InputTarget[] = [
        ...st.rooms.map((r) => ({ kind: 'room' as const, id: r.id, name: r.name })),
        ...friends.map((f) => ({ kind: 'dm' as const, id: f.id, name: f.username })),
      ];
      const curId = st.activeDmPeerId ?? st.activeRoomId ?? st.rooms[0]?.id ?? null;
      const curKind = st.activeDmPeerId ? 'dm' : 'room';
      const current = gameTargetRef.current ?? (targets.find((t) => t.kind === curKind && t.id === curId) ?? null);
      return { current, targets };
    };
    gameMode.setInputTargetProvider(buildGameTargets);
    gameMode.setOnInputShown(() => {
      gameTargetRef.current = null;
    });
    // input 窗口点选目标：只更新独立目标并回发（不切主窗口会话）
    let offSelect: (() => void) | undefined;
    let disposed = false;
    void listen<{ kind?: 'room' | 'dm'; id?: string }>('game-input-select', (e) => {
      const kind = e.payload?.kind;
      const id = e.payload?.id;
      if ((kind !== 'room' && kind !== 'dm') || !id) return;
      gameTargetRef.current = { kind, id, name: buildGameTargets().targets.find((t) => t.kind === kind && t.id === id)?.name ?? '' };
      void gameMode.emitInputTarget(buildGameTargets());
    }).then((off) => {
      if (disposed) off();
      else offSelect = off;
    });
    if (gameModeEnabled) {
      void gameMode.startGameMode();
    } else {
      void gameMode.stopGameMode();
    }
    return () => {
      disposed = true;
      offSelect?.();
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
        setLightboxOffset(clampLightboxOffset(lightboxZoom, { x: d.ox + (e.clientX - d.sx), y: d.oy + (e.clientY - d.sy) }));
        lightboxDrag.current = null;
        return;
      }
      const dx = e.clientX - d.sx;
      const dy = e.clientY - d.sy;
      if (Math.abs(dx) + Math.abs(dy) > 3) lightboxMoved.current = true;
      d.lx = e.clientX;
      d.ly = e.clientY;
      setLightboxOffset(clampLightboxOffset(lightboxZoom, { x: d.ox + dx, y: d.oy + dy }));
    };
    const onUp = () => {
      const d = lightboxDrag.current;
      if (!d) return;
      // 定格到最后一次已知位置（合成的 up 事件坐标不可信）
      setLightboxOffset({ x: d.ox + (d.lx - d.sx), y: d.oy + (d.ly - d.sy) });
      lightboxDrag.current = null;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightbox(null);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('keydown', onKey);
    };
  }, [lightbox, lightboxZoom]);

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

  // 通知点击跳转：Windows 通知被点击时系统会聚焦应用窗口——监听焦点恢复，
  // 消费「待跳转会话」记录切到对应会话（正在输入草稿时不打断，避免覆盖思路）
  useEffect(() => {
    let off: (() => void) | undefined;
    let disposed = false;
    try {
      void getCurrentWindow()
        .onFocusChanged(({ payload }) => {
          if (!payload) return;
          const { pendingNotifyTarget } = useChat.getState();
          if (!pendingNotifyTarget) return;
          if (draft.trim() || editingMsg || pendingImage) return;
          useChat.getState().consumePendingNotifyTarget();
        })
        .then((fn) => {
          if (disposed) fn();
          else off = fn;
        });
    } catch (e) {
      console.error('focus listen failed', e);
    }
    return () => {
      disposed = true;
      off?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, editingMsg, pendingImage]);

  // 切换会话（房间/私聊）时取消未完成的编辑/回复/@提及/待发图片与滚动锚定，
  // 避免旧会话的交互状态泄漏进新会话（@ 补全残留会让 Enter 被劫持为插入手打文本）
  useEffect(() => {
    setEditingMsg(null);
    setReplyTo(null);
    setMentionQuery(null);
    pickedMentions.current.clear();
    setPendingImage(null);
    anchorRef.current = null;
  }, [activeRoomId, activeDmPeerId]);

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
      {/* 图标导航栏（QQ NT 式 rail）：品牌 / 消息 / 好友 / 底部账号 */}
      <aside className="rail">
        <div className="rail-brand">
          <img src={appIcon} alt="GameTalk" className="logo-img" draggable={false} />
        </div>
        {!offline && (
          <nav className="rail-nav">
            <button
              type="button"
              className={`rail-item ${sideTab === 'rooms' ? 'active' : ''}`}
              title="消息"
              onClick={() => setSideTab('rooms')}
            >
              <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
              {(() => {
                const total =
                  Object.values(unreadByRoom).reduce((a, b) => a + b, 0) + Object.values(dmUnread).reduce((a, b) => a + b, 0);
                return total > 0 ? <span className="rail-badge">{total > 99 ? '99+' : total}</span> : null;
              })()}
            </button>
            <button
              type="button"
              className={`rail-item ${sideTab === 'friends' ? 'active' : ''}`}
              title="好友"
              onClick={() => {
                setSideTab('friends');
                void loadFriends();
              }}
            >
              <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                <path d="M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
              {friendIncoming.length > 0 && (
                <span className="rail-badge">{friendIncoming.length > 99 ? '99+' : friendIncoming.length}</span>
              )}
            </button>
          </nav>
        )}
        <div className="rail-bottom">
          <button
            className={`user-trigger rail-user ${userMenuOpen ? 'open' : ''}`}
            onClick={() => setUserMenuOpen((v) => !v)}
            title="账号菜单"
          >
            <Avatar name={offline ? '访客' : (user?.username ?? '')} url={user?.avatarUrl} size={34} />
          </button>
        </div>
      </aside>

      {/* 会话 / 好友列表列 */}
      <aside className="listbar">
        <div className="listbar-header">
          <span className="listbar-title">{offline || sideTab === 'rooms' ? '消息' : '好友'}</span>
        </div>
        <div className="listbar-body">
        {(offline || sideTab === 'rooms') ? (
        <>
        {!offline && dmSidebar.length > 0 && (
          <>
            <div className="rooms-header dm-header">
              <span>私聊</span>
            </div>
            <nav className="rooms dm-rooms">
              {dmSidebar.map(({ friend, preview }) => (
                <div
                  key={friend.id}
                  className={`room-item ${friend.id === activeDmPeerId ? 'active' : ''}`}
                  onClick={() => void openDm(friend.id)}
                  title={friend.online ? '在线' : '离线'}
                >
                  <span className={`dm-avatar-wrap ${friend.online ? 'online' : 'off'}`}>
                    <Avatar name={friend.username} url={friend.avatarUrl} size={34} />
                  </span>
                  <div className="room-main">
                    <div className="room-line1">
                      <span className="room-name">{friend.username}</span>
                      {!!dmUnread[friend.id] && (
                        <span className="room-badge">{dmUnread[friend.id] > 99 ? '99+' : dmUnread[friend.id]}</span>
                      )}
                      {preview && <span className="room-time">{formatRoomTime(preview.createdAt)}</span>}
                    </div>
                    <div className="room-preview">
                      {preview
                        ? preview.text === '撤回了一条消息'
                          ? `${preview.userId === me?.id ? '你' : preview.username}撤回了一条消息`
                          : `${preview.userId === me?.id ? '我' : preview.username}：${preview.text}`
                        : '开始聊天吧'}
                    </div>
                  </div>
                </div>
              ))}
            </nav>
          </>
        )}
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
                className={`room-item ${r.id === activeRoomId && !activeDm ? 'active' : ''}`}
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
                      {/* 撤回预览 QQ 式：无冒号；代撤文案由 store 生成（「撤回了 XX 的消息」），此处拼操作者名 */}
                      {previewByRoom[r.id].text.startsWith('撤回了')
                        ? `${previewByRoom[r.id].userId === me?.id ? '你' : previewByRoom[r.id].username}${previewByRoom[r.id].text}`
                        : `${previewByRoom[r.id].username}：${previewByRoom[r.id].text}`}
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
          <div className="friends-header">
            <span>好友管理</span>
            <span className="friends-count">{friends.length} 位好友</span>
          </div>
          <button type="button" className={`friends-add-toggle ${showAddFriend ? 'open' : ''}`} onClick={() => setShowAddFriend((v) => !v)}>
            {showAddFriend ? '收起添加框' : '＋ 添加好友'}
          </button>
          {showAddFriend && (
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
          )}
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
                className={`friend-item ${f.online ? 'online' : 'offline'} ${f.id === selectedFriendId ? 'selected' : ''}`}
                title="单击查看资料 · 双击发消息 · 右键更多操作"
                onClick={() => setSelectedFriendId(f.id)}
                onDoubleClick={() => {
                  setSideTab('rooms');
                  void openDm(f.id);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setSelectedFriendId(f.id);
                  setFriendMenu({
                    friend: f,
                    x: Math.min(e.clientX, window.innerWidth - 170),
                    y: Math.min(e.clientY, window.innerHeight - 110),
                    confirmRemove: false,
                  });
                }}
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

        </div>
      </aside>

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

      <main className="main">
        {!offline && sideTab === 'friends' ? (
          selectedFriend ? (
            <FriendProfilePane
              key={selectedFriend.id}
              friend={selectedFriend}
              onMessage={() => {
                setSideTab('rooms');
                void openDm(selectedFriend.id);
              }}
              onRemove={() => void removeFriendById(selectedFriend.id)}
              onClose={() => setSelectedFriendId(null)}
            />
          ) : (
            <div className="friend-pane-empty">
              <p className="empty-title">好友资料</p>
              <p className="empty-sub">在左侧选择一位好友查看资料；双击好友可直接发消息。</p>
            </div>
          )
        ) : (
          <>
        <header className="topbar">
          <div className="topbar-title">
            {activeDm && !offline ? (
              <>
                <span className={`topbar-dm-avatar ${activeDm.online ? '' : 'off'}`}>
                  <Avatar name={activeDm.username} url={activeDm.avatarUrl} size={30} />
                </span>
                <span>{activeDm.username}</span>
                <span className={`dm-online-tag ${activeDm.online ? 'ok' : ''}`}>{activeDm.online ? '在线' : '离线'}</span>
              </>
            ) : activeRoom && !offline ? (
              <>
                <span
                  className="topbar-avatar"
                  aria-hidden
                  style={{ background: `hsl(${[...(activeRoom.name || '#')].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7)} 32% 42%)` }}
                >
                  {(activeRoom.name || '#').slice(0, 1)}
                </span>
                <span>{activeRoom.name}</span>
                <span className="me-tag">邀请码 {activeRoom.inviteCode}</span>
              </>
            ) : (
              <>
                <span className="hash">#</span>
                <span>{offline ? '离线模式' : '未选择会话'}</span>
              </>
            )}
          </div>
          <div className="topbar-right">
            {offline && <span className="offline-tag">离线模式</span>}
            <StatusDot status={status} />
            {/* 订阅状态只在已连接时有意义；断开/重连中由状态灯表达；DM 无订阅概念 */}
            {!offline && connected && activeRoom && !activeDm && (
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
          {!offline && activeDm && activeDmPeerId && dmHasMore[activeDmPeerId] && (
            <button
              className="load-older"
              disabled={!!loadingOlderRooms[`dm:${activeDmPeerId}`]}
              onClick={() => void handleLoadOlder()}
            >
              {loadingOlderRooms[`dm:${activeDmPeerId}`] ? '加载中…' : '加载更早的消息'}
            </button>
          )}
          {!offline && !activeDm && activeRoom && hasMoreByRoom[activeRoom.id] && (
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
          {!offline && !activeDm && !activeRoom && (
            <div className="empty">
              <p className="empty-title">选择一个会话</p>
              <p className="empty-sub">创建新房间、加入房间，或在好友列表发起私聊。</p>
              <button className="btn primary" style={{ marginTop: 14 }} onClick={() => setShowRoomModal(true)}>
                创建 / 加入房间
              </button>
            </div>
          )}
          {!offline && activeDm && dmMessagesList.length === 0 && !dmHistoryLoaded[activeDmPeerId!] && (
            <div className="empty">
              <p className="empty-title">加载聊天记录…</p>
              <p className="empty-sub">正在从服务器拉取与 {activeDm.username} 的私聊记录。</p>
            </div>
          )}
          {!offline && activeDm && dmMessagesList.length === 0 && !!dmHistoryLoaded[activeDmPeerId!] && (
            <div className="empty">
              <p className="empty-title">和 {activeDm.username} 打个招呼吧</p>
              <p className="empty-sub">这是你们的私密对话，只有彼此可见。</p>
            </div>
          )}
          {!offline && !activeDm && activeRoom && messages.length === 0 && !historyLoadedRooms[activeRoom.id] && (
            <div className="empty">
              <p className="empty-title">加载历史消息…</p>
              <p className="empty-sub">正在从服务器拉取该房间的历史记录。</p>
            </div>
          )}
          {!offline && !activeDm && activeRoom && messages.length === 0 && historyLoadedRooms[activeRoom.id] && (
            <div className="empty">
              <p className="empty-title">欢迎来到 #{activeRoom.name}</p>
              <p className="empty-sub">发送第一条消息，开始与房间里的玩家实时沟通。</p>
            </div>
          )}
          {messages.map((m, i) => {
            const prev = messages[i - 1];
            const grouped = !m.recalled && !prev?.recalled && isGroupedWithPrev(prev, m);
            const showDay =
              i === 0 ||
              new Date(m.createdAt).toDateString() !== new Date(prev.createdAt).toDateString();
            if (m.recalled) {
              // QQ 式撤回：气泡消失，居中小字提示
              return (
                <Fragment key={m.id}>
                  {showDay && (
                    <div className="day-divider">
                      <span>{formatDay(m.createdAt)}</span>
                    </div>
                  )}
                  <div className="recall-line">{recallLineOf(m, me?.id)}</div>
                </Fragment>
              );
            }
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
                      // DM：对方头像右键 → 二级菜单（查看资料 / 删除好友）
                      if (activeDm) {
                        if (m.userId !== me?.id) {
                          setDmMsgMenu({
                            member: { id: m.userId, username: m.username, avatarUrl: m.avatarUrl ?? null },
                            x: Math.min(e.clientX, window.innerWidth - 170),
                            y: Math.min(e.clientY, window.innerHeight - 110),
                            confirmRemove: false,
                          });
                        }
                        return;
                      }
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
                      {m.forwardedFromLabel && <span className="message-forwarded" title={m.forwardedFromLabel}>转发</span>}
                      {m.editedAt && <span className="message-edited">已编辑</span>}
                    </div>
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
              <div className="emoji-tabs">
                <button type="button" className={`emoji-tab ${emojiTab === 'emoji' ? 'active' : ''}`} onClick={() => setEmojiTab('emoji')}>
                  表情
                </button>
                <button type="button" className={`emoji-tab ${emojiTab === 'mine' ? 'active' : ''}`} onClick={() => setEmojiTab('mine')}>
                  我的表情包
                </button>
                <button
                  type="button"
                  className={`emoji-tab ${emojiTab === 'room' ? 'active' : ''}`}
                  onClick={() => setEmojiTab('room')}
                  disabled={!activeRoomId}
                  title={activeRoomId ? '当前房间的共享表情' : '进入房间后可用'}
                >
                  群表情
                </button>
              </div>
              {emojiTab === 'emoji' ? (
                <>
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
                </>
              ) : emojiTab === 'mine' ? (
                <div className="sticker-wrap">
                  <div className="sticker-hint">云端同步，所有设备可用；支持 GIF 动图，最多 {MAX_STICKERS} 个</div>
                  <div className="sticker-grid">
                    {myStickers.map((st) => (
                      <div key={st.id} className="sticker-cell">
                        <button
                          type="button"
                          className="sticker-img-btn"
                          title="点击发送"
                          onMouseDown={(ev) => { ev.preventDefault(); sendSticker(st.mediaId); }}
                        >
                          <img src={absUrl(st.url)} alt="表情包" loading="lazy" />
                        </button>
                        <button type="button" className="sticker-remove" title="移除" onClick={() => void removeSticker(st, 'mine')}>
                          ×
                        </button>
                      </div>
                    ))}
                    {myStickers.length < MAX_STICKERS && (
                      <button
                        type="button"
                        className="sticker-add"
                        title={stickerUploading ? '上传中…' : '添加表情包'}
                        disabled={stickerUploading}
                        onClick={() => stickerInputRef.current?.click()}
                      >
                        {stickerUploading ? '…' : '+'}
                      </button>
                    )}
                  </div>
                  {myStickers.length === 0 && !stickerBusy && (
                    <div className="sticker-empty">还没有表情包，点「+」从本地添加 GIF/图片，云端同步所有设备</div>
                  )}
                </div>
              ) : (
                <div className="sticker-wrap">
                  {activeRoomId ? (
                    <>
                      <div className="sticker-hint">本房间共享表情，成员共同贡献；点击发送，× 移除（添加者或房主）</div>
                      <div className="sticker-grid">
                        {roomStickers.map((st) => (
                          <div key={st.id} className="sticker-cell">
                            <button
                              type="button"
                              className="sticker-img-btn"
                              title={st.addedByUsername ? `由 ${st.addedByUsername} 添加 · 点击发送` : '点击发送'}
                              onMouseDown={(ev) => { ev.preventDefault(); sendSticker(st.mediaId); }}
                            >
                              <img src={absUrl(st.url)} alt="群表情" loading="lazy" />
                            </button>
                            {(st.addedBy === me?.id || activeRoom?.ownerId === me?.id) && (
                              <button type="button" className="sticker-remove" title="移除" onClick={() => void removeSticker(st, 'room')}>
                                ×
                              </button>
                            )}
                          </div>
                        ))}
                        {roomStickers.length < MAX_STICKERS && (
                          <button
                            type="button"
                            className="sticker-add"
                            title={stickerUploading ? '上传中…' : '添加群表情'}
                            disabled={stickerUploading}
                            onClick={() => stickerInputRef.current?.click()}
                          >
                            {stickerUploading ? '…' : '+'}
                          </button>
                        )}
                      </div>
                      {roomStickers.length === 0 && !stickerBusy && (
                        <div className="sticker-empty">本房间还没有共享表情，点「+」添加，全群可见</div>
                      )}
                    </>
                  ) : (
                    <div className="sticker-empty">进入一个房间后，即可使用全群共享的表情</div>
                  )}
                </div>
              )}
            </div>
          )}
          <input
            ref={stickerInputRef}
            type="file"
            accept="image/gif,image/png,image/jpeg,image/webp"
            style={{ display: 'none' }}
            onChange={(e) => {
              void onPickStickerFile(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
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
          {editingMsg && (
            <div className="reply-bar edit-bar">
              <span className="reply-label">正在编辑</span>
              <span className="reply-snippet">{editingMsg.kind === 'image' && !editingMsg.text ? '[图片]' : editingMsg.text}</span>
              <button className="attachment-remove" title="取消编辑" onClick={cancelEdit}>
                ×
              </button>
            </div>
          )}
          <div className="composer-row">
          <button
            className="composer-icon"
            title={uploading ? '图片上传中…' : '发送图片'}
            disabled={offline || !connected || (!activeRoom && !activeDm) || uploading}
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
            disabled={offline || !connected || (!activeRoom && !activeDm)}
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
            placeholder={
              offline
                ? '离线模式：未连接服务器'
                : editingMsg
                  ? '正在编辑消息，Enter 确认，Esc 取消'
                  : connected
                    ? activeDm
                      ? `与 ${activeDm.username} 私聊，Enter 发送`
                      : activeRoom
                        ? '输入消息，Enter 发送，@ 唤起提及'
                        : '先选择或创建房间'
                    : '未连接'
            }
            disabled={offline || !connected || (!activeRoom && !activeDm)}
            maxLength={2000}
            onPaste={(e) => {
              // 支持直接粘贴截图/图片：走附件上传流程（可配文字后发送）
              const file = [...e.clipboardData.items].find((it) => it.type.startsWith('image/'))?.getAsFile();
              if (file) {
                e.preventDefault();
                void onPickImageFile(file);
              }
            }}
            onChange={(e) => {
              const v = e.target.value;
              setDraft(v);
              const caret = e.target.selectionStart ?? v.length;
              const m = /@([\w\u4e00-\u9fa5-]{0,24})$/.exec(v.slice(0, caret));
              // DM 无提及语义，不开 @ 自动补全
              if (m && !offline && connected && !activeDm) {
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
              if (e.key === 'Escape' && editingMsg) {
                e.preventDefault();
                cancelEdit();
                return;
              }
              if (e.key === 'Enter' && !e.shiftKey && !offline && connected && (activeRoom || activeDm)) {
                e.preventDefault();
                sendDraft();
              }
            }}
          />
          <button
            className="btn primary"
            disabled={offline || !connected || (!activeRoom && !activeDm) || (!draft.trim() && !pendingImage)}
            onClick={sendDraft}
          >
            {editingMsg ? '保存' : '发送'}
          </button>
          {activeRoom && !activeDm && (
            <button className="btn ghost" title="离开房间" onClick={() => void leaveActiveRoom()}>
              离开
            </button>
          )}
          </div>
        </footer>

        <footer className="status-bar">
          <button className="status-item" title="在设置中管理" onClick={() => void openSettingsWindow('game')}>
            游戏模式 {offline ? '未登录' : gameModeEnabled ? `已开启 · ${hotkey}` : '已关闭'}
          </button>
          <button className="status-item" title="在设置中管理" onClick={() => void openSettingsWindow('notify')}>
            通知 {soundEnabled ? '提示音开' : '提示音关'} · {notifyLevel === 'all' ? '全部通知' : notifyLevel === 'mention' ? '仅@通知' : '不通知'}
          </button>
        </footer>
          </>
        )}
      </main>

      {/* 成员面板（QQ 式花名册）：离线成员置灰保留 + 房主标注 + 房主管理；DM 会话与好友 Tab 不显示 */}
      {!offline && sideTab === 'rooms' && activeRoom && !activeDm && (
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
                  onClick={() => setCardMember({ member: m, from: 'room' })}
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
            <button
              className="ctx-menu-item"
              onClick={() => {
                const room = rooms.find((r) => r.id === roomMenu.id);
                if (room) setInvitePanelRoom(room);
                setRoomMenu(null);
              }}
            >
              邀请链接…
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
                setCardMember({ member: memberMenu.member, from: 'room' });
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
      {msgMenu && (activeRoom || activeDm) && (
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
                setEditingMsg(null);
                setMsgMenu(null);
              }}
            >
              引用
            </button>
            {!msgMenu.msg.pending && (
              <button
                className="ctx-menu-item"
                onClick={() => {
                  setForwardPicker({ msg: msgMenu.msg, source: activeDm ? 'dm' : 'room' });
                  setMsgMenu(null);
                }}
              >
                转发
              </button>
            )}
            {msgMenu.msg.userId === me?.id && !msgMenu.msg.pending && !msgMenu.msg.recalled &&
              !(msgMenu.msg.kind === 'image' && !msgMenu.msg.text) && (
              /* 纯图消息无文字可改，不提供编辑入口 */
              <button
                className="ctx-menu-item"
                onClick={() => {
                  startEdit(msgMenu.msg);
                  setMsgMenu(null);
                }}
              >
                编辑
              </button>
            )}
            {activeDm ? (
              // 私聊：仅发送者本人可撤回（无房主语义）
              msgMenu.msg.userId === me?.id &&
              !msgMenu.msg.pending && (
                <button
                  className="ctx-menu-item danger"
                  onClick={() => {
                    recallDm(msgMenu.msg.id);
                    setMsgMenu(null);
                  }}
                >
                  撤回
                </button>
              )
            ) : (
              (msgMenu.msg.userId === me?.id || activeRoom?.ownerId === me?.id) &&
              !msgMenu.msg.pending && (
                <button
                  className="ctx-menu-item danger"
                  onClick={() => {
                    if (activeRoom) recallMessage(activeRoom.id, msgMenu.msg.id);
                    setMsgMenu(null);
                  }}
                >
                  {msgMenu.msg.userId === me?.id ? '撤回' : '撤回（房主）'}
                </button>
              )
            )}
          </CtxMenu>
        </>
      )}
      {friendMenu && (
        <>
          <div className="menu-mask" onClick={() => setFriendMenu(null)} />
          <CtxMenu x={friendMenu.x} y={friendMenu.y}>
            <button
              className="ctx-menu-item"
              onClick={() => {
                setCardMember({ member: friendMenu.friend, from: 'friend' });
                setFriendMenu(null);
              }}
            >
              查看资料
            </button>
            <button
              className="ctx-menu-item danger"
              onClick={() => {
                if (!friendMenu.confirmRemove) {
                  // 二次确认：3s 内再点一次才真正删除
                  setFriendMenu({ ...friendMenu, confirmRemove: true });
                  setTimeout(() => setFriendMenu((fm) => (fm?.confirmRemove ? { ...fm, confirmRemove: false } : fm)), 3000);
                  return;
                }
                void removeFriendById(friendMenu.friend.id);
                setFriendMenu(null);
              }}
            >
              {friendMenu.confirmRemove ? '确认删除好友？' : '删除好友'}
            </button>
          </CtxMenu>
        </>
      )}
      {dmMsgMenu && (
        <>
          <div className="menu-mask" onClick={() => setDmMsgMenu(null)} />
          <CtxMenu x={dmMsgMenu.x} y={dmMsgMenu.y}>
            <button
              className="ctx-menu-item"
              onClick={() => {
                setCardMember({ member: dmMsgMenu.member, from: 'friend' });
                setDmMsgMenu(null);
              }}
            >
              查看资料
            </button>
            <button
              className="ctx-menu-item danger"
              onClick={() => {
                if (!dmMsgMenu.confirmRemove) {
                  setDmMsgMenu({ ...dmMsgMenu, confirmRemove: true });
                  setTimeout(() => setDmMsgMenu((mm) => (mm?.confirmRemove ? { ...mm, confirmRemove: false } : mm)), 3000);
                  return;
                }
                void removeFriendById(dmMsgMenu.member.id);
                setDmMsgMenu(null);
              }}
            >
              {dmMsgMenu.confirmRemove ? '确认删除好友？' : '删除好友'}
            </button>
          </CtxMenu>
        </>
      )}
      {showProfile && <ProfileModal onClose={() => setShowProfile(false)} />}
      {/* 房间上下文的成员卡片（成员面板/成员菜单打开）：含房主管理项 */}
      {cardMember?.from === 'room' && activeRoom && (
        <MemberCardModal
          member={cardMember.member}
          isOwner={cardMember.member.id === activeRoom.ownerId}
          canKick={activeRoom.ownerId === me?.id && cardMember.member.id !== me?.id}
          onKick={() => {
            kickMember(activeRoom.id, cardMember.member.id);
            setCardMember(null);
          }}
          friendStatus={relationOf(cardMember.member.id)}
          onAddFriend={() => void sendRequest(cardMember.member.id)}
          onMessage={() => {
            setCardMember(null);
            setSideTab('rooms');
            void openDm(cardMember.member.id);
          }}
          onRemoveFriend={() => {
            void removeFriendById(cardMember.member.id);
            setCardMember(null);
          }}
          onClose={() => setCardMember(null)}
        />
      )}
      {/* 好友卡片（好友列表右键 / 私聊头像右键打开）：与房间管理完全无关，无「移出房间」 */}
      {cardMember?.from === 'friend' && !offline && (
        <MemberCardModal
          member={cardMember.member}
          isOwner={false}
          canKick={false}
          onKick={() => undefined}
          friendStatus={relationOf(cardMember.member.id)}
          onAddFriend={() => void sendRequest(cardMember.member.id)}
          onMessage={() => {
            setCardMember(null);
            setSideTab('rooms');
            void openDm(cardMember.member.id);
          }}
          onRemoveFriend={() => {
            void removeFriendById(cardMember.member.id);
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
            zoomLightboxTo(lightboxZoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
          }}
          onMouseDown={(e) => {
            // 任何缩放（含 <100%）都可拖拽平移；拖拽用 window 级 mouse 监听：松手必停
            lightboxDrag.current = { id: 0, sx: e.clientX, sy: e.clientY, ox: lightboxOffset.x, oy: lightboxOffset.y, lx: e.clientX, ly: e.clientY };
            lightboxMoved.current = false;
          }}
        >
          <img
            ref={lightboxImgRef}
            src={lightbox}
            alt="图片预览"
            draggable={false}
            // 阻止原生图片拖拽：浏览器接管后 move 事件停发（指针变禁止、松手才更新位置）
            onDragStart={(e) => e.preventDefault()}
            style={{ transform: `translate(${lightboxOffset.x}px, ${lightboxOffset.y}px) scale(${lightboxZoom})`, cursor: 'grab' }}
            onClick={(e) => e.stopPropagation()}
          />
          <div className="lightbox-toolbar" onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
            <button title="缩小" onClick={() => zoomLightboxTo(lightboxZoom / 1.25)}>
              −
            </button>
            <span className="lightbox-zoom">{Math.round(lightboxZoom * 100)}%</span>
            <button title="放大" onClick={() => zoomLightboxTo(lightboxZoom * 1.25)}>
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

      {forwardPicker && (
        <ForwardPickerModal msg={forwardPicker.msg} source={forwardPicker.source} onClose={() => setForwardPicker(null)} />
      )}
      {invitePanelRoom && <InviteLinkModal room={invitePanelRoom} onClose={() => setInvitePanelRoom(null)} />}
      {pendingInvite && (
        <DeepLinkInviteModal
          code={pendingInvite}
          onClose={() => {
            setPendingInvite(null);
            try {
              localStorage.removeItem(PENDING_INVITE_KEY);
            } catch {
              // 同上：不可用则跳过
            }
          }}
        />
      )}
    </div>
  );
}

/** 转发选择器：从我的房间与好友私聊中挑一个目标，经服务端复制消息（来源标签由服务端生成） */
function ForwardPickerModal({
  msg,
  source,
  onClose,
}: {
  msg: RoomMessage;
  source: 'room' | 'dm';
  onClose: () => void;
}) {
  const rooms = useChat((s) => s.rooms);
  const forwardMessage = useChat((s) => s.forwardMessage);
  const friends = useFriends((s) => s.friends);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const preview = msg.recalled ? '（已撤回）' : msg.kind === 'image' && !msg.text ? '[图片]' : msg.text.slice(0, 60);
  const send = (label: string, target: { roomId?: string; userId?: string }) => {
    forwardMessage(source, msg.id, target);
    setSentTo(label);
    setTimeout(onClose, 500);
  };
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal forward-modal" onClick={(e) => e.stopPropagation()}>
        <h3>转发消息</h3>
        <p className="forward-preview">{preview}</p>
        {sentTo ? (
          <p className="forward-done">已转发到「{sentTo}」</p>
        ) : (
          <>
            <div className="forward-section">转发到房间</div>
            <div className="forward-list">
              {rooms.length === 0 && <span className="forward-empty">暂无房间</span>}
              {rooms.map((r) => (
                <button key={r.id} type="button" className="forward-item" onClick={() => send(r.name, { roomId: r.id })}>
                  <Avatar name={r.name} url={null} size={26} />
                  <span className="forward-name">{r.name}</span>
                </button>
              ))}
            </div>
            <div className="forward-section">转发给好友（私聊）</div>
            <div className="forward-list">
              {friends.length === 0 && <span className="forward-empty">暂无好友</span>}
              {friends.map((f) => (
                <button key={f.id} type="button" className="forward-item" onClick={() => send(f.username, { userId: f.id })}>
                  <Avatar name={f.username} url={f.avatarUrl} size={26} />
                  <span className="forward-name">{f.username}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** 邀请链接管理：成员创建（可设有效期/次数）、复制 deep link、吊销（创建者或房主） */
function InviteLinkModal({ room, onClose }: { room: api.Room; onClose: () => void }) {
  const me = useChat((s) => s.me);
  const [invites, setInvites] = useState<api.InviteLink[] | null>(null);
  const [expiresHours, setExpiresHours] = useState(0);
  const [maxUses, setMaxUses] = useState(0);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const token = useAuth.getState().token ?? '';

  const load = async () => {
    try {
      const r = await api.listInviteLinks(token, room.id);
      setInvites(r.invites);
    } catch {
      setInvites([]);
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.id]);

  const create = async () => {
    setBusy(true);
    try {
      await api.createInviteLink(token, room.id, {
        expiresInHours: expiresHours || undefined,
        maxUses: maxUses || undefined,
      });
      await load();
    } catch {
      // 错误信息由全局 roomError 提示，这里仅收尾
    } finally {
      setBusy(false);
    }
  };
  const copyLink = async (code: string) => {
    await copyText(`gametalk://join?code=${code}`);
    setCopied(code);
    setTimeout(() => setCopied((c) => (c === code ? null : c)), 1500);
  };
  const revoke = async (code: string) => {
    try {
      await api.revokeInviteLink(token, code);
      await load();
    } catch {
      // 失败静默：列表刷新即反馈
    }
  };
  const fmtExpiry = (iso: string | null) => (iso ? `有效期至 ${new Date(iso).toLocaleString()}` : '永久有效');
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal invite-modal" onClick={(e) => e.stopPropagation()}>
        <h3>邀请链接 · {room.name}</h3>
        <div className="invite-create">
          <select value={expiresHours} onChange={(e) => setExpiresHours(Number(e.target.value))}>
            <option value={0}>永久有效</option>
            <option value={24}>24 小时</option>
            <option value={168}>7 天</option>
            <option value={720}>30 天</option>
          </select>
          <select value={maxUses} onChange={(e) => setMaxUses(Number(e.target.value))}>
            <option value={0}>不限次数</option>
            <option value={1}>限 1 次</option>
            <option value={10}>限 10 次</option>
            <option value={50}>限 50 次</option>
          </select>
          <button className="btn primary" disabled={busy} onClick={() => void create()}>
            生成链接
          </button>
        </div>
        <div className="invite-list">
          {invites === null && <p className="invite-empty">加载中…</p>}
          {invites !== null && invites.length === 0 && <p className="invite-empty">还没有邀请链接，生成一个发给朋友吧。</p>}
          {(invites ?? []).map((inv) => {
            const expired = inv.expiresAt !== null && new Date(inv.expiresAt).getTime() < Date.now();
            const exhausted = inv.maxUses > 0 && inv.usedCount >= inv.maxUses;
            return (
              <div key={inv.id} className={`invite-item ${expired || exhausted ? 'dead' : ''}`}>
                <div className="invite-meta">
                  <code className="invite-code">{inv.code}</code>
                  <span className="invite-sub">
                    {fmtExpiry(inv.expiresAt)}
                    {inv.maxUses > 0 ? ` · 已用 ${inv.usedCount}/${inv.maxUses}` : ''}
                    {inv.inviterName ? ` · ${inv.inviterName} 创建` : ''}
                    {expired ? ' · 已过期' : exhausted ? ' · 已用完' : ''}
                  </span>
                </div>
                <div className="invite-actions">
                  <button type="button" className="btn ghost small" onClick={() => void copyLink(inv.code)}>
                    {copied === inv.code ? '已复制' : '复制链接'}
                  </button>
                  {!expired && !exhausted && (
                    <button
                      type="button"
                      className="btn ghost small danger-text"
                      disabled={!(inv.createdBy === me?.id || room.ownerId === me?.id)}
                      title={inv.createdBy === me?.id || room.ownerId === me?.id ? '吊销此链接' : '仅创建者或房主可吊销'}
                      onClick={() => void revoke(inv.code)}
                    >
                      吊销
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <p className="invite-hint">链接形如 gametalk://join?code=…，对方点击将直接拉起 GameTalk 加入本房间。</p>
      </div>
    </div>
  );
}

/** deep link 邀请确认：展示房间名/邀请人/资格，确认后 redeem 入房并切换会话 */
function DeepLinkInviteModal({ code, onClose }: { code: string; onClose: () => void }) {
  const token = useAuth.getState().token;
  const [preview, setPreview] = useState<{
    roomName: string;
    inviterName: string;
    expiresAt: string | null;
    maxUses: number;
    usedCount: number;
    valid: boolean;
    alreadyMember: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);

  useEffect(() => {
    if (!token) {
      setError('请先登录 GameTalk，再通过链接加入房间');
      return;
    }
    api
      .getInvitePreview(token, code)
      .then((r) => setPreview(r.invite))
      .catch((e) => setError(e instanceof Error ? e.message : '邀请链接无效'));
  }, [code, token]);

  const join = async () => {
    if (!token || !preview) return;
    setJoining(true);
    try {
      const r = await api.redeemInvite(token, code);
      await useChat.getState().refreshRooms();
      await useChat.getState().selectRoom(r.room.id, true);
      try {
        localStorage.removeItem(PENDING_INVITE_KEY);
      } catch {
        // 同上
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : '加入失败，请稍后重试');
    } finally {
      setJoining(false);
    }
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal invite-confirm" onClick={(e) => e.stopPropagation()}>
        <h3>房间邀请</h3>
        {error ? (
          <p className="invite-error">{error}</p>
        ) : !preview ? (
          <p className="invite-empty">正在获取邀请信息…</p>
        ) : (
          <>
            <p className="invite-room-name">{preview.roomName}</p>
            <p className="invite-sub center">
              {preview.inviterName} 邀请你加入
              {preview.expiresAt ? ` · ${new Date(preview.expiresAt).toLocaleString()} 过期` : ' · 永久有效'}
              {preview.maxUses > 0 ? ` · 剩余 ${Math.max(0, preview.maxUses - preview.usedCount)} 次名额` : ''}
            </p>
            {!preview.valid ? (
              <p className="invite-error">该邀请链接已失效。</p>
            ) : preview.alreadyMember ? (
              <>
                <p className="invite-sub center">你已在该房间中。</p>
                <button className="btn primary block" onClick={() => void join()}>
                  打开房间
                </button>
              </>
            ) : (
              <button className="btn primary block" disabled={joining} onClick={() => void join()}>
                {joining ? '正在加入…' : '加入房间'}
              </button>
            )}
          </>
        )}
      </div>
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

  // gametalk:// 邀请链接：根组件监听（登录页也活着），码存 localStorage 中转给 ChatView。
  // 所有 Tauri API 一律 try/catch + 动态 import：浏览器（无运行时）可能同步 throw（白屏事故教训）。
  useEffect(() => {
    const handleUrl = (raw: string) => {
      const m = /code=([A-Za-z0-9]+)/.exec(raw);
      if (!m) return;
      const code = (m[1] ?? '').toUpperCase();
      try {
        localStorage.setItem(PENDING_INVITE_KEY, code);
      } catch {
        // 同上
      }
      window.dispatchEvent(new CustomEvent('gametalk-invite'));
    };
    const offs: Array<() => void> = [];
    void import('@tauri-apps/plugin-deep-link')
      .then(async (dl) => {
        try {
          const cur = await dl.getCurrent();
          const u = cur?.[0];
          if (u) handleUrl(String(u));
        } catch {
          // 无 Tauri 运行时（浏览器）或无冷启动 URL
        }
        try {
          const un = await dl.onOpenUrl((urls) => {
            const u = urls?.[0];
            if (u) handleUrl(String(u));
          });
          offs.push(un);
        } catch {
          // onOpenUrl 仅桌面运行时可用
        }
      })
      .catch(() => {});
    // Windows 运行中点击链接：单实例回调经 Rust emit 转发
    void import('@tauri-apps/api/event')
      .then(async ({ listen }) => {
        try {
          const un = await listen<string>('deep-link-url', (e) => handleUrl(String(e.payload ?? '')));
          offs.push(un);
        } catch {
          // 事件监听在无运行时时不可用
        }
      })
      .catch(() => {});
    return () => {
      for (const off of offs) {
        try {
          off();
        } catch {
          // unlisten 抛错可忽略
        }
      }
    };
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
