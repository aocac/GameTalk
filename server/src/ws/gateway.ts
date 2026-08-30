import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { RawData, WebSocket } from 'ws';
import type { QueryResultRow } from 'pg';
import type { Config } from '../config.js';
import type { Db } from '../db/db.js';
import type { JwtService } from '../lib/jwt.js';
import { avatarHttpUrlOf, httpBaseOf } from '../lib/avatar.js';

/**
 * WebSocket 网关（Phase 3+）：JWT 认证 + 内存房间表。
 * - hello 携带 token，认证成功后绑定用户
 * - 房间成员按 userId 去重（同一用户可多连接，广播到其所有 socket）
 * - 消息广播实时分发；持久化在 Phase 4 加入
 */

const MAX_TEXT_LENGTH = 2000;

/** 单连接限流：WS_RATE_WINDOW_MS 滑动窗口内最多 WS_RATE_MAX 条消息（含 hello/ping），超出回 rate_limited */
export const WS_RATE_WINDOW_MS = 5000;
export const WS_RATE_MAX = 25;
/** 服务端心跳：定期发协议层 ping（所有标准 WS 客户端自动 pong）；超时未 pong 视为死连接
 *  直接 terminate（close 事件负责清理房间订阅），避免半开连接在成员表里变成"幽灵成员" */
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 70_000;

interface Conn {
  socket: WebSocket;
  userId: string | null;
  username: string;
  avatarUrl: string | null;
  rooms: Set<string>;
  /** 连接升级时推导的对外 http base（头像等资源绝对 URL 用） */
  httpBase: string;
  /** 最近一次收到协议层 pong 的时间（服务端心跳存活检测） */
  lastPongAt: number;
  /** 限流滑动窗口内的消息时间戳 */
  sentAt: number[];
}

interface ChatMessage {
  id: string;
  roomId: string;
  userId: string;
  username: string;
  avatarUrl: string | null;
  text: string;
  createdAt: string;
  /** 被提及的用户快照（历史渲染不依赖成员表） */
  mentions?: MentionRef[];
  /** 'image' 时 mediaUrl 指向 /api/media/:id（对外转绝对 URL） */
  kind?: 'text' | 'image';
  mediaUrl?: string | null;
  /** 引用回复的原消息快照 */
  reply?: ReplyRef;
  /** 已撤回：内容已清空，客户端渲染占位文案 */
  recalled?: boolean;
  /** 编辑时间（ISO；仅编辑过的消息携带） */
  editedAt?: string;
  /** 转发来源快照（纯展示，如「来自 群A · 张三」） */
  forwardedFromLabel?: string | null;
}

interface MentionRef {
  id: string;
  username: string;
}

/** 好友私聊消息（与房间消息分离：无 roomId/提及/禁言语义，from/to 表达会话方向） */
interface DmMessage {
  id: string;
  from: string;
  to: string;
  username: string;
  avatarUrl: string | null;
  text: string;
  createdAt: string;
  kind: 'text' | 'image';
  mediaUrl: string | null;
  reply?: ReplyRef;
  recalled?: boolean;
  /** 编辑时间（ISO；仅编辑过的消息携带） */
  editedAt?: string;
  /** 转发来源快照（纯展示，如「来自 群A · 张三」） */
  forwardedFromLabel?: string | null;
}

/** 引用回复快照：随消息入库/广播，渲染不依赖原消息仍在客户端历史窗口内 */
interface ReplyRef {
  id: string;
  username: string;
  text: string;
  kind: 'text' | 'image';
}

/** 房间花名册成员 = 全体 DB 成员 + 当前在线标记（QQ 式：离线成员也展示，灰头像） */
interface RosterMember {
  id: string;
  username: string;
  avatarUrl: string | null;
  online: boolean;
  /** 生效中的禁言截止时间（ISO；null = 未被禁言） */
  mutedUntil: string | null;
}

type ClientMessage =
  | { type: 'hello'; payload: { token: string } }
  | { type: 'room:join'; payload: { roomId: string } }
  | { type: 'room:leave'; payload: { roomId: string } }
  | { type: 'room:delete'; payload: { roomId: string } }
  | { type: 'member:kick'; payload: { roomId: string; userId: string } }
  | { type: 'member:mute'; payload: { roomId: string; userId: string; minutes: unknown } }
  | { type: 'member:unmute'; payload: { roomId: string; userId: string } }
  | { type: 'message:send'; payload: { roomId: string; text: string; mentions?: unknown; mediaUrl?: unknown; replyTo?: unknown } }
  | { type: 'message:recall'; payload: { roomId: string; messageId: string } }
  | { type: 'message:edit'; payload: { roomId: string; messageId: string; text: string } }
  | { type: 'dm:send'; payload: { to: string; text: string; mediaUrl?: unknown; replyTo?: unknown } }
  | { type: 'dm:recall'; payload: { messageId: string } }
  | { type: 'dm:edit'; payload: { messageId: string; text: string } }
  | {
      type: 'message:forward';
      payload: { source: unknown; messageId: unknown; targetRoomId?: unknown; targetUserId?: unknown };
    }
  | { type: 'screen:start'; payload: { roomId: string } }
  | { type: 'screen:stop'; payload: { roomId: string } }
  | { type: 'screen:signal'; payload: { roomId: string; to: string; data: unknown } }
  | { type: 'ping' };

interface UserRow extends QueryResultRow {
  id: string;
  username: string;
  avatar_url: string | null;
}

/** roomId -> userId -> { username, avatarUrl, sockets }（同一用户可能多端连接） */
const rooms = new Map<string, Map<string, { username: string; avatarUrl: string | null; sockets: Set<WebSocket> }>>();

/** 全部存活连接（心跳巡检 / 踢人清理用；close 事件负责移除） */
const connections = new Set<Conn>();

/** 向指定用户的所有在线连接推送（好友请求 / 好友动态等系统通知） */
export function sendToUser(userId: string, msg: unknown): void {
  for (const c of connections) {
    if (c.userId === userId) send(c.socket, msg);
  }
}

/** 当前在线用户集合（好友列表在线标记用） */
export function onlineUserIds(): Set<string> {
  const s = new Set<string>();
  for (const c of connections) {
    if (c.userId) s.add(c.userId);
  }
  return s;
}

function sanitizeRoomId(id: string): string {
  return id.trim().slice(0, 64);
}

function safeText(text: string): string {
  return text.trim().slice(0, MAX_TEXT_LENGTH);
}

/**
 * 解析消息提及：客户端显式选择的 ids ∪ 文本中 @用户名 的兜底解析，均须为房间成员；
 * 提及自己无意义，自动剔除。用户名唯一，按名精确匹配可靠。
 */
async function resolveMentions(db: Db, roomId: string, senderId: string, text: string, picked: unknown): Promise<MentionRef[]> {
  const res = await db.query<{ user_id: string; username: string }>(
    `SELECT rm.user_id, u.username
     FROM room_members rm JOIN users u ON u.id = rm.user_id
     WHERE rm.room_id = $1`,
    [roomId],
  );
  const rows = res.rows;
  const byId = new Map(rows.map((r) => [r.user_id, r.username] as const));
  const byName = new Map(rows.map((r) => [r.username.toLowerCase(), r.user_id] as const));
  const mentioned = new Map<string, string>();
  if (Array.isArray(picked)) {
    for (const p of picked) {
      const id = typeof p === 'string' ? p : '';
      if (id && byId.has(id)) mentioned.set(id, byId.get(id)!);
    }
  }
  for (const m of text.matchAll(/@([\w\u4e00-\u9fa5-]{3,24})/gu)) {
    const id = byName.get((m[1] ?? '').toLowerCase());
    if (id) mentioned.set(id, byId.get(id)!);
  }
  mentioned.delete(senderId);
  return [...mentioned].map(([id, username]) => ({ id, username }));
}

function send(socket: WebSocket, msg: unknown): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(msg));
  }
}

function broadcastToRoom(roomId: string, msg: unknown, except?: WebSocket): void {
  const members = rooms.get(roomId);
  if (!members) return;
  for (const entry of members.values()) {
    for (const s of entry.sockets) {
      if (s !== except) send(s, msg);
    }
  }
}

function publicMember(userId: string, username: string, avatarUrl?: string | null) {
  return { id: userId, username, avatarUrl: avatarUrl ?? null };
}

/** 花名册：DB 全体成员（按加入时间）+ 内存连接表推导的在线标记 + 生效中的禁言 */
async function roomRosterOf(db: Db, roomId: string, httpBase: string): Promise<RosterMember[]> {
  const res = await db.query<{ id: string; username: string; avatar_url: string | null; muted_until: string | null }>(
    `SELECT u.id, u.username, u.avatar_url, m.muted_until
     FROM room_members rm
     JOIN users u ON u.id = rm.user_id
     LEFT JOIN room_mutes m ON m.room_id = rm.room_id AND m.user_id = rm.user_id AND m.muted_until > now()
     WHERE rm.room_id = $1
     ORDER BY rm.joined_at ASC`,
    [roomId],
  );
  const online = rooms.get(roomId);
  return res.rows.map((r) => ({
    id: r.id,
    username: r.username,
    avatarUrl: avatarHttpUrlOf(httpBase, r.id, r.avatar_url),
    online: !!online?.has(r.id),
    mutedUntil: r.muted_until ? new Date(r.muted_until).toISOString() : null,
  }));
}

async function joinRoom(conn: Conn, roomId: string, db: Db, avatarUrl?: string | null): Promise<void> {
  if (!conn.userId) return;
  // 幂等：重复加入也总是回复 room:joined —— 否则客户端重试加入会被静默吞掉，
  // 订阅响应一旦丢失将永远无法收敛（客户端看门狗依赖该回执）
  conn.rooms.add(roomId);

  let members = rooms.get(roomId);
  if (!members) {
    members = new Map();
    rooms.set(roomId, members);
  }
  let entry = members.get(conn.userId);
  const isNewMember = !entry;
  if (!entry) {
    entry = { username: conn.username, avatarUrl: avatarUrl ?? null, sockets: new Set() };
    members.set(conn.userId, entry);
  }
  entry.sockets.add(conn.socket);
  // 回执携带完整花名册（含离线成员与在线标记），客户端据此渲染 QQ 式成员列表
  const roster = await roomRosterOf(db, roomId, conn.httpBase);
  send(conn.socket, { type: 'room:joined', payload: { roomId, members: roster } });
  if (isNewMember) {
    broadcastToRoom(
      roomId,
      { type: 'member:joined', payload: { roomId, member: publicMember(conn.userId, conn.username, conn.avatarUrl) } },
      conn.socket,
    );
  }
}

function leaveRoom(conn: Conn, roomId: string): void {
  if (!conn.rooms.delete(roomId)) return;
  const members = rooms.get(roomId);
  if (!members) return;
  const entry = members.get(conn.userId ?? '');
  if (entry) {
    entry.sockets.delete(conn.socket);
    if (entry.sockets.size === 0) {
      members.delete(conn.userId ?? '');
      // 该用户在此房间的最后一个连接断开 = 「离线」。
      // 语义注意：成员关系仍在 DB 花名册中（QQ 式离线置灰），客户端不应把成员从列表移除
      broadcastToRoom(
        roomId,
        {
          type: 'member:left',
          payload: { roomId, userId: conn.userId, username: entry.username },
        },
        conn.socket,
      );
    }
  }
  if (members.size === 0) rooms.delete(roomId);
}

/** 好友在线状态广播：某用户首次上线 / 最后下线时通知其全部在线好友 */
async function broadcastFriendPresence(db: Db, userId: string, online: boolean): Promise<void> {
  try {
    const res = await db.query<{ requester_id: string; addressee_id: string }>(
      `SELECT requester_id, addressee_id FROM friendships
       WHERE status = 'accepted' AND (requester_id = $1 OR addressee_id = $1)`,
      [userId],
    );
    for (const row of res.rows) {
      const friendId = row.requester_id === userId ? row.addressee_id : row.requester_id;
      sendToUser(friendId, { type: 'presence:friend', payload: { userId, online } });
    }
  } catch (e) {
    console.error('friend presence broadcast failed:', e);
  }
}

export function registerWsRoutes(app: FastifyInstance, deps: { config: Config; db: Db; jwt: JwtService }): void {
  const { db, jwt } = deps;

  // 服务端心跳巡检：ping 所有存活连接，无 pong 的死连接 terminate（close 事件负责清理订阅）
  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const conn of connections) {
      if (conn.socket.readyState !== conn.socket.OPEN) continue;
      if (now - conn.lastPongAt > HEARTBEAT_TIMEOUT_MS) {
        conn.socket.terminate();
      } else {
        conn.socket.ping();
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
  app.addHook('onClose', async () => {
    clearInterval(heartbeat);
  });

  app.get('/ws', { websocket: true }, (socket, request: FastifyRequest) => {
    const conn: Conn = {
      socket,
      userId: null,
      username: 'Player',
      avatarUrl: null,
      rooms: new Set(),
      httpBase: httpBaseOf(request.headers),
      lastPongAt: Date.now(),
      sentAt: [],
    };
    connections.add(conn);
    socket.on('pong', () => {
      conn.lastPongAt = Date.now();
    });
    socket.on('message', (raw: RawData) => {
      // 统一兜底：任何 DB/逻辑异常不能变成 unhandled rejection 崩掉整个进程
      handleMessage(conn, raw, db, jwt).catch((e) => {
        console.error('ws message handling failed:', e);
        send(conn.socket, { type: 'error', payload: { code: 'internal_error', message: 'internal error' } });
      });
    });
    socket.on('close', () => {
      connections.delete(conn);
      for (const roomId of [...conn.rooms]) leaveRoom(conn, roomId);
      // 该用户的最后一个连接断开 → 通知其在线好友「已离线」
      if (conn.userId) {
        const stillOnline = [...connections].some((c) => c.userId === conn.userId);
        if (!stillOnline) void broadcastFriendPresence(db, conn.userId, false);
      }
    });
    socket.on('error', () => {
      // error 后必然触发 close，房间清理统一交给 close
    });
  });
}

async function handleMessage(conn: Conn, raw: RawData, db: Db, jwt: JwtService): Promise<void> {
  // 单连接限流：滑动窗口计数，超出直接拒绝（防止刷屏拖垮广播与数据库）
  const now = Date.now();
  conn.sentAt = conn.sentAt.filter((t) => now - t < WS_RATE_WINDOW_MS);
  if (conn.sentAt.length >= WS_RATE_MAX) {
    send(conn.socket, { type: 'error', payload: { code: 'rate_limited', message: 'too many messages, slow down' } });
    return;
  }
  conn.sentAt.push(now);

  let msg: ClientMessage;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    send(conn.socket, { type: 'error', payload: { code: 'bad_json', message: 'invalid message' } });
    return;
  }

  switch (msg.type) {
    case 'hello': {
      if (!conn.userId) {
        const token = String(msg.payload.token ?? '');
        try {
          const payload = await jwt.verify(token);
          const found = await db.query<UserRow>('SELECT id, username, avatar_url FROM users WHERE id = $1', [payload.sub]);
          const user = found.rows[0];
          if (!user) throw new Error('user not found');
          conn.userId = user.id;
          conn.username = user.username;
          // data URL 头像一律转成 HTTP 端点 URL，避免 base64 随广播/成员表内嵌
          conn.avatarUrl = avatarHttpUrlOf(conn.httpBase, user.id, user.avatar_url);
          send(conn.socket, { type: 'hello:ok', payload: { me: publicMember(user.id, user.username, conn.avatarUrl) } });
          // 该用户的第一个连接 → 通知其在线好友「已上线」
          const wasOnline = [...connections].some((c) => c !== conn && c.userId === user.id);
          if (!wasOnline) void broadcastFriendPresence(db, user.id, true);
        } catch {
          send(conn.socket, { type: 'error', payload: { code: 'unauthorized', message: 'invalid token' } });
          conn.socket.close();
        }
      }
      break;
    }
    case 'room:join': {
      if (!conn.userId) {
        send(conn.socket, { type: 'error', payload: { code: 'not_authenticated', message: 'hello first' } });
        return;
      }
      const roomId = sanitizeRoomId(msg.payload.roomId);
      // 仅允许房间成员订阅该房间的实时消息
      const member = await db.query('SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2', [
        roomId,
        conn.userId,
      ]);
      if (member.rows.length === 0) {
        send(conn.socket, {
          type: 'error',
          payload: { code: 'not_in_room', message: 'you are not a member of this room', roomId },
        });
        return;
      }
      const avatar = await db.query<{ avatar_url: string | null }>('SELECT avatar_url FROM users WHERE id = $1', [
        conn.userId,
      ]);
      conn.avatarUrl = avatarHttpUrlOf(conn.httpBase, conn.userId, avatar.rows[0]?.avatar_url ?? null);
      await joinRoom(conn, roomId, db, conn.avatarUrl);
      break;
    }
    case 'room:leave': {
      leaveRoom(conn, sanitizeRoomId(msg.payload.roomId));
      break;
    }
    case 'room:delete': {
      // 删除房间：仅房主可删；级联删除消息/成员，并广播给所有在线成员
      if (!conn.userId) {
        send(conn.socket, { type: 'error', payload: { code: 'not_authenticated', message: 'hello first' } });
        return;
      }
      const roomId = sanitizeRoomId(msg.payload.roomId);
      const found = await db.query<{ owner_id: string }>('SELECT owner_id FROM rooms WHERE id = $1', [roomId]);
      if (found.rows.length === 0) {
        send(conn.socket, { type: 'error', payload: { code: 'room_not_found', message: 'room not found' } });
        return;
      }
      if (found.rows[0].owner_id !== conn.userId) {
        send(conn.socket, { type: 'error', payload: { code: 'only_owner', message: 'only the room owner can delete the room' } });
        return;
      }
      await db.query('DELETE FROM rooms WHERE id = $1', [roomId]); // messages/room_members 级联删除
      // 通知所有在线成员（含房主自己），并清理内存订阅
      const members = rooms.get(roomId);
      if (members) {
        const payload = { type: 'room:deleted', payload: { roomId } };
        for (const entry of members.values()) {
          for (const s of entry.sockets) {
            if (s.readyState === s.OPEN) s.send(JSON.stringify(payload));
          }
        }
        rooms.delete(roomId);
      }
      break;
    }
    case 'member:kick': {
      // 房主管理权限：把成员移出房间（DB 移除 + 实时通知 + 订阅清理）
      if (!conn.userId) {
        send(conn.socket, { type: 'error', payload: { code: 'not_authenticated', message: 'hello first' } });
        return;
      }
      const roomId = sanitizeRoomId(msg.payload.roomId);
      const targetId = String(msg.payload.userId ?? '');
      const found = await db.query<{ owner_id: string }>('SELECT owner_id FROM rooms WHERE id = $1', [roomId]);
      if (found.rows.length === 0) {
        send(conn.socket, { type: 'error', payload: { code: 'room_not_found', message: 'room not found' } });
        return;
      }
      if (found.rows[0].owner_id !== conn.userId) {
        send(conn.socket, { type: 'error', payload: { code: 'only_owner', message: 'only the room owner can kick members' } });
        return;
      }
      if (!targetId || targetId === conn.userId) {
        send(conn.socket, { type: 'error', payload: { code: 'invalid_input', message: 'cannot kick yourself' } });
        return;
      }
      const isMember = await db.query('SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2', [
        roomId,
        targetId,
      ]);
      if (isMember.rows.length === 0) {
        send(conn.socket, { type: 'error', payload: { code: 'not_in_room', message: 'target is not a member', roomId } });
        return;
      }
      await db.query('DELETE FROM room_members WHERE room_id = $1 AND user_id = $2', [roomId, targetId]);

      // 内存清理：被踢者所有连接的房间订阅全部移除（防其继续 message:send 走旧订阅）
      for (const c of connections) {
        if (c.userId === targetId) c.rooms.delete(roomId);
      }
      const members = rooms.get(roomId);
      const entry = members?.get(targetId);
      const kickedName = entry?.username ?? '';
      const kickedSockets = entry ? [...entry.sockets] : [];
      if (members) {
        members.delete(targetId);
        if (members.size === 0) rooms.delete(roomId);
      }
      // 通知房间其余成员，再单独通知被踢者全部连接（显式收件人，不做二次查表）
      const notice = { type: 'member:kicked', payload: { roomId, userId: targetId, username: kickedName } };
      if (members) {
        for (const [uid, e] of members) {
          if (uid === targetId) continue;
          for (const s of e.sockets) send(s, notice);
        }
      }
      for (const s of kickedSockets) send(s, notice);
      break;
    }
    case 'member:mute': {
      // 房主管理权限：限时禁言成员（到期自动失效）；房主本人不可被禁言
      if (!conn.userId) {
        send(conn.socket, { type: 'error', payload: { code: 'not_authenticated', message: 'hello first' } });
        return;
      }
      const roomId = sanitizeRoomId(msg.payload.roomId);
      const targetId = String(msg.payload.userId ?? '');
      const minutes = Math.floor(Number(msg.payload.minutes));
      const found = await db.query<{ owner_id: string }>('SELECT owner_id FROM rooms WHERE id = $1', [roomId]);
      if (found.rows.length === 0) {
        send(conn.socket, { type: 'error', payload: { code: 'room_not_found', message: 'room not found' } });
        return;
      }
      if (found.rows[0].owner_id !== conn.userId) {
        send(conn.socket, { type: 'error', payload: { code: 'only_owner', message: 'only the room owner can mute members' } });
        return;
      }
      if (!Number.isFinite(minutes) || minutes < 1 || minutes > 60 * 24 * 30) {
        send(conn.socket, { type: 'error', payload: { code: 'invalid_input', message: 'mute duration must be 1 minute to 30 days' } });
        return;
      }
      if (!targetId || targetId === conn.userId || targetId === found.rows[0].owner_id) {
        send(conn.socket, { type: 'error', payload: { code: 'invalid_input', message: 'cannot mute yourself or the owner' } });
        return;
      }
      const isMember = await db.query('SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2', [roomId, targetId]);
      if (isMember.rows.length === 0) {
        send(conn.socket, { type: 'error', payload: { code: 'not_in_room', message: 'target is not a member', roomId } });
        return;
      }
      await db.query(
        `INSERT INTO room_mutes (room_id, user_id, muted_until) VALUES ($1, $2, now() + ($3 || ' minutes')::interval)
         ON CONFLICT (room_id, user_id) DO UPDATE SET muted_until = excluded.muted_until, created_at = now()`,
        [roomId, targetId, String(minutes)],
      );
      broadcastToRoom(roomId, {
        type: 'member:muted',
        payload: { roomId, userId: targetId, mutedUntil: new Date(Date.now() + minutes * 60_000).toISOString() },
      });
      break;
    }
    case 'member:unmute': {
      // 房主解除禁言
      if (!conn.userId) {
        send(conn.socket, { type: 'error', payload: { code: 'not_authenticated', message: 'hello first' } });
        return;
      }
      const roomId = sanitizeRoomId(msg.payload.roomId);
      const targetId = String(msg.payload.userId ?? '');
      const found = await db.query<{ owner_id: string }>('SELECT owner_id FROM rooms WHERE id = $1', [roomId]);
      if (found.rows.length === 0) {
        send(conn.socket, { type: 'error', payload: { code: 'room_not_found', message: 'room not found' } });
        return;
      }
      if (found.rows[0].owner_id !== conn.userId) {
        send(conn.socket, { type: 'error', payload: { code: 'only_owner', message: 'only the room owner can unmute members' } });
        return;
      }
      await db.query('DELETE FROM room_mutes WHERE room_id = $1 AND user_id = $2', [roomId, targetId]);
      broadcastToRoom(roomId, { type: 'member:unmuted', payload: { roomId, userId: targetId } });
      break;
    }
    case 'message:send': {
      if (!conn.userId) {
        send(conn.socket, { type: 'error', payload: { code: 'not_authenticated', message: 'hello first' } });
        return;
      }
      const roomId = sanitizeRoomId(msg.payload.roomId);
      const text = safeText(msg.payload.text);
      const mediaUrl = typeof msg.payload.mediaUrl === 'string' ? msg.payload.mediaUrl : null;
      // 图片消息允许空文本；纯文本消息仍拒绝空串
      if (!text && !mediaUrl) {
        send(conn.socket, { type: 'error', payload: { code: 'empty_message', message: 'message is empty' } });
        return;
      }
      if (!conn.rooms.has(roomId)) {
        send(conn.socket, { type: 'error', payload: { code: 'not_in_room', message: 'not in room', roomId } });
        return;
      }
      // 禁言检查：生效中的禁言拒绝发送（带截止时间供客户端展示）
      const muted = await db.query<{ muted_until: string }>(
        'SELECT muted_until FROM room_mutes WHERE room_id = $1 AND user_id = $2 AND muted_until > now()',
        [roomId, conn.userId],
      );
      if (muted.rows.length > 0) {
        send(conn.socket, {
          type: 'error',
          payload: { code: 'muted', message: 'you are muted in this room', roomId, mutedUntil: new Date(muted.rows[0].muted_until).toISOString() },
        });
        return;
      }
      // 图片消息：mediaUrl 必须是本服务媒体端点且属于发送者（防伪造他人媒体引用）
      let kind: 'text' | 'image' = 'text';
      let storedMediaUrl: string | null = null;
      if (mediaUrl) {
        const m = /^\/api\/media\/([0-9a-f-]{36})$/.exec(mediaUrl);
        if (!m) {
          send(conn.socket, { type: 'error', payload: { code: 'invalid_input', message: 'invalid media url' } });
          return;
        }
        const owned = await db.query('SELECT 1 FROM media WHERE id = $1 AND owner_id = $2', [m[1], conn.userId]);
        if (owned.rows.length === 0) {
          // 非自传媒体：允许使用本房间共享表情中的媒体（成员贡献、全群使用）
          const shared = await db.query('SELECT 1 FROM room_stickers WHERE media_id = $1 AND room_id = $2', [
            m[1],
            roomId,
          ]);
          if (shared.rows.length === 0) {
            send(conn.socket, { type: 'error', payload: { code: 'invalid_input', message: 'media not found' } });
            return;
          }
        }
        kind = 'image';
        storedMediaUrl = mediaUrl;
      }
      // 引用回复：校验同房间原消息；快照（截断 80 字，原消息已撤回则占位）随消息入库与广播
      let replyTo: string | null = null;
      let reply: ReplyRef | undefined;
      const rawReply = typeof msg.payload.replyTo === 'string' ? msg.payload.replyTo : '';
      if (rawReply) {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawReply)) {
          send(conn.socket, { type: 'error', payload: { code: 'invalid_input', message: 'invalid reply id' } });
          return;
        }
        const r = await db.query<{ id: string; username: string; text: string; kind: string; recalled: boolean }>(
          'SELECT id, username, text, kind, recalled FROM messages WHERE id = $1 AND room_id = $2',
          [rawReply, roomId],
        );
        const row = r.rows[0];
        if (!row) {
          send(conn.socket, { type: 'error', payload: { code: 'message_not_found', message: 'reply target not found' } });
          return;
        }
        replyTo = rawReply;
        reply = {
          id: row.id,
          username: row.username,
          text: row.recalled ? '消息已撤回' : row.text.slice(0, 80),
          kind: (row.kind === 'image' ? 'image' : 'text') as 'image' | 'text',
        };
      }
      // 持久化后再广播（Phase 4：消息历史；v0.4.0：提及解析入库 + 图片消息；v0.4.1：引用回复）
      const mentions = await resolveMentions(db, roomId, conn.userId, text, msg.payload.mentions);
      const inserted = await db.query<{ id: string; created_at: string; mentions: MentionRef[] }>(
        'INSERT INTO messages (room_id, user_id, username, text, mentions, kind, media_url, reply_to) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8) RETURNING id, created_at, mentions',
        [roomId, conn.userId, conn.username, text, JSON.stringify(mentions), kind, storedMediaUrl, replyTo],
      );
      const row = inserted.rows[0];
      const message: ChatMessage = {
        id: row.id,
        roomId,
        userId: conn.userId,
        username: conn.username,
        avatarUrl: conn.avatarUrl,
        text,
        createdAt: row.created_at,
        mentions: row.mentions ?? [],
        kind,
        // 广播用发送者的 httpBase 转绝对 URL（与头像策略一致）
        mediaUrl: storedMediaUrl ? `${conn.httpBase}${storedMediaUrl}` : null,
        reply,
      };
      broadcastToRoom(roomId, { type: 'message:new', payload: { roomId, message } });
      break;
    }
    case 'message:recall': {
      // 撤回：发送者本人或房间主可撤；撤回后内容清空（text/media 置空），广播 member:recalled 语义事件
      if (!conn.userId) {
        send(conn.socket, { type: 'error', payload: { code: 'not_authenticated', message: 'hello first' } });
        return;
      }
      const roomId = sanitizeRoomId(msg.payload.roomId);
      const messageId = sanitizeRoomId(msg.payload.messageId);
      if (!conn.rooms.has(roomId)) {
        send(conn.socket, { type: 'error', payload: { code: 'not_in_room', message: 'not in room', roomId } });
        return;
      }
      const found = await db.query<{ user_id: string }>(
        'SELECT user_id FROM messages WHERE id = $1 AND room_id = $2 AND recalled = false',
        [messageId, roomId],
      );
      const target = found.rows[0];
      if (!target) {
        send(conn.socket, { type: 'error', payload: { code: 'message_not_found', message: 'message not found' } });
        return;
      }
      if (target.user_id !== conn.userId) {
        const owner = await db.query<{ owner_id: string }>('SELECT owner_id FROM rooms WHERE id = $1', [roomId]);
        if (owner.rows.length === 0 || owner.rows[0].owner_id !== conn.userId) {
          send(conn.socket, { type: 'error', payload: { code: 'only_owner', message: 'only the sender or the room owner can recall' } });
          return;
        }
      }
      // 记录撤回操作者（房主代撤时客户端文案为「房主撤回了 XX 的消息」，历史同样可查）
      const updated = await db.query<{ id: string }>(
        'UPDATE messages SET recalled = true, text = \'\', media_url = NULL, mentions = \'[]\'::jsonb, recalled_by = $3 WHERE id = $1 AND room_id = $2 RETURNING id',
        [messageId, roomId, conn.userId],
      );
      if (updated.rows.length > 0) {
        broadcastToRoom(roomId, {
          type: 'message:recalled',
          payload: { roomId, messageId, operatorId: conn.userId, operatorUsername: conn.username },
        });
      }
      break;
    }
    case 'dm:send': {
      // 好友私聊：仅 accepted 好友可互发；持久化后向双方所有连接广播
      if (!conn.userId) {
        send(conn.socket, { type: 'error', payload: { code: 'not_authenticated', message: 'hello first' } });
        return;
      }
      const to = String(msg.payload.to ?? '');
      const text = safeText(msg.payload.text);
      const mediaUrl = typeof msg.payload.mediaUrl === 'string' ? msg.payload.mediaUrl : null;
      if (!text && !mediaUrl) {
        send(conn.socket, { type: 'error', payload: { code: 'empty_message', message: 'message is empty', to, from: conn.userId } });
        return;
      }
      if (!to || to === conn.userId) {
        send(conn.socket, { type: 'error', payload: { code: 'invalid_input', message: 'invalid dm target', to, from: conn.userId } });
        return;
      }
      const friend = await db.query(
        `SELECT 1 FROM friendships
         WHERE status = 'accepted'
           AND ((requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1))`,
        [conn.userId, to],
      );
      if (friend.rows.length === 0) {
        send(conn.socket, { type: 'error', payload: { code: 'not_friends', message: '仅好友之间可以私聊', to, from: conn.userId } });
        return;
      }
      // 图片消息：mediaUrl 必须是本服务媒体端点且属于发送者（与房间消息同策略）
      let kind: 'text' | 'image' = 'text';
      let storedMediaUrl: string | null = null;
      if (mediaUrl) {
        const m = /^\/api\/media\/([0-9a-f-]{36})$/.exec(mediaUrl);
        if (!m) {
          send(conn.socket, { type: 'error', payload: { code: 'invalid_input', message: 'invalid media url', to, from: conn.userId } });
          return;
        }
        const owned = await db.query('SELECT 1 FROM media WHERE id = $1 AND owner_id = $2', [m[1], conn.userId]);
        if (owned.rows.length === 0) {
          // 非自传媒体：允许使用双方任一人收藏的云表情，或任一群共享表情（成员贡献、跨会话使用）
          const shared = await db.query(
            `SELECT 1 FROM user_stickers WHERE media_id = $1 AND owner_id IN ($2, $3)
             UNION
             SELECT 1 FROM room_stickers WHERE media_id = $1`,
            [m[1], conn.userId, to],
          );
          if (shared.rows.length === 0) {
            send(conn.socket, { type: 'error', payload: { code: 'invalid_input', message: 'media not found', to, from: conn.userId } });
            return;
          }
        }
        kind = 'image';
        storedMediaUrl = mediaUrl;
      }
      // 引用回复：原消息必须属于本会话（双向对）；快照随消息入库与广播
      let replyTo: string | null = null;
      let reply: ReplyRef | undefined;
      const rawReply = typeof msg.payload.replyTo === 'string' ? msg.payload.replyTo : '';
      if (rawReply) {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawReply)) {
          send(conn.socket, { type: 'error', payload: { code: 'invalid_input', message: 'invalid reply id', to, from: conn.userId } });
          return;
        }
        const r = await db.query<{ id: string; username: string; text: string; kind: string; recalled: boolean }>(
          `SELECT id, username, text, kind, recalled FROM dm_messages
           WHERE id = $1 AND ((sender_id = $2 AND recipient_id = $3) OR (sender_id = $3 AND recipient_id = $2))`,
          [rawReply, conn.userId, to],
        );
        const row = r.rows[0];
        if (!row) {
          send(conn.socket, { type: 'error', payload: { code: 'message_not_found', message: 'reply target not found', to, from: conn.userId } });
          return;
        }
        replyTo = rawReply;
        reply = {
          id: row.id,
          username: row.username,
          text: row.recalled ? '消息已撤回' : row.text.slice(0, 80),
          kind: (row.kind === 'image' ? 'image' : 'text') as 'image' | 'text',
        };
      }
      const inserted = await db.query<{ id: string; created_at: string }>(
        'INSERT INTO dm_messages (sender_id, recipient_id, username, text, kind, media_url, reply_to) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, created_at',
        [conn.userId, to, conn.username, text, kind, storedMediaUrl, replyTo],
      );
      const row = inserted.rows[0];
      const message: DmMessage = {
        id: row.id,
        from: conn.userId,
        to,
        username: conn.username,
        avatarUrl: conn.avatarUrl,
        text,
        createdAt: row.created_at,
        kind,
        mediaUrl: storedMediaUrl ? `${conn.httpBase}${storedMediaUrl}` : null,
        recalled: false,
        reply,
      };
      sendToUser(conn.userId, { type: 'dm:new', payload: { message } });
      sendToUser(to, { type: 'dm:new', payload: { message } });
      break;
    }
    case 'message:edit': {
      // 编辑：仅发送者本人、未撤回的消息；只更新文本（kind/media 不变），广播新文本与编辑时间
      if (!conn.userId) {
        send(conn.socket, { type: 'error', payload: { code: 'not_authenticated', message: 'hello first' } });
        return;
      }
      const roomId = sanitizeRoomId(msg.payload.roomId);
      const messageId = sanitizeRoomId(msg.payload.messageId);
      const text = safeText(msg.payload.text);
      if (!text) {
        send(conn.socket, { type: 'error', payload: { code: 'empty_message', message: 'edited text is empty' } });
        return;
      }
      if (!conn.rooms.has(roomId)) {
        send(conn.socket, { type: 'error', payload: { code: 'not_in_room', message: 'not in room', roomId } });
        return;
      }
      const found = await db.query<{ user_id: string }>(
        'SELECT user_id FROM messages WHERE id = $1 AND room_id = $2 AND recalled = false',
        [messageId, roomId],
      );
      const target = found.rows[0];
      if (!target) {
        send(conn.socket, { type: 'error', payload: { code: 'message_not_found', message: 'message not found' } });
        return;
      }
      if (target.user_id !== conn.userId) {
        send(conn.socket, { type: 'error', payload: { code: 'only_sender', message: '只有发送者可以编辑消息' } });
        return;
      }
      const updated = await db.query<{ edited_at: string }>(
        'UPDATE messages SET text = $2, edited_at = now() WHERE id = $1 AND recalled = false RETURNING edited_at',
        [messageId, text],
      );
      if (updated.rows.length > 0) {
        broadcastToRoom(roomId, {
          type: 'message:edited',
          payload: { roomId, messageId, text, editedAt: new Date(updated.rows[0].edited_at).toISOString() },
        });
      }
      break;
    }
    case 'dm:recall': {
      // 私聊撤回：仅发送者本人可撤（无房主概念）；撤回后内容清空并通知双方
      if (!conn.userId) {
        send(conn.socket, { type: 'error', payload: { code: 'not_authenticated', message: 'hello first' } });
        return;
      }
      const messageId = sanitizeRoomId(msg.payload.messageId);
      const found = await db.query<{ sender_id: string; recipient_id: string }>(
        'SELECT sender_id, recipient_id FROM dm_messages WHERE id = $1 AND recalled = false',
        [messageId],
      );
      const target = found.rows[0];
      if (!target) {
        send(conn.socket, { type: 'error', payload: { code: 'message_not_found', message: 'message not found' } });
        return;
      }
      if (target.sender_id !== conn.userId) {
        send(conn.socket, { type: 'error', payload: { code: 'only_sender', message: '只有发送者可以撤回私聊消息' } });
        return;
      }
      const updated = await db.query<{ id: string }>(
        "UPDATE dm_messages SET recalled = true, text = '', media_url = NULL WHERE id = $1 RETURNING id",
        [messageId],
      );
      if (updated.rows.length > 0) {
        sendToUser(target.sender_id, { type: 'dm:recalled', payload: { messageId, from: target.sender_id, to: target.recipient_id } });
        sendToUser(target.recipient_id, { type: 'dm:recalled', payload: { messageId, from: target.sender_id, to: target.recipient_id } });
      }
      break;
    }
    case 'dm:edit': {
      // 私聊编辑：仅发送者本人、未撤回；更新后通知双方
      if (!conn.userId) {
        send(conn.socket, { type: 'error', payload: { code: 'not_authenticated', message: 'hello first' } });
        return;
      }
      const messageId = sanitizeRoomId(msg.payload.messageId);
      const text = safeText(msg.payload.text);
      if (!text) {
        send(conn.socket, { type: 'error', payload: { code: 'empty_message', message: 'edited text is empty' } });
        return;
      }
      const found = await db.query<{ sender_id: string; recipient_id: string }>(
        'SELECT sender_id, recipient_id FROM dm_messages WHERE id = $1 AND recalled = false',
        [messageId],
      );
      const target = found.rows[0];
      if (!target) {
        send(conn.socket, { type: 'error', payload: { code: 'message_not_found', message: 'message not found' } });
        return;
      }
      if (target.sender_id !== conn.userId) {
        send(conn.socket, { type: 'error', payload: { code: 'only_sender', message: '只有发送者可以编辑私聊消息' } });
        return;
      }
      const updated = await db.query<{ edited_at: string }>(
        'UPDATE dm_messages SET text = $2, edited_at = now() WHERE id = $1 AND recalled = false RETURNING edited_at',
        [messageId, text],
      );
      if (updated.rows.length > 0) {
        const notice = {
          type: 'dm:edited',
          payload: { messageId, from: target.sender_id, to: target.recipient_id, text, editedAt: new Date(updated.rows[0].edited_at).toISOString() },
        };
        sendToUser(target.sender_id, notice);
        sendToUser(target.recipient_id, notice);
      }
      break;
    }
    case 'message:forward': {
      // 转发：把房间/私聊里可见的一条消息复制到目标会话（文本/图片原样，引用与提及不带走）。
      // 服务端代为复制 media_url，天然绕过媒体归属校验（原校验已保证入库合法），杜绝伪造引用。
      if (!conn.userId) {
        send(conn.socket, { type: 'error', payload: { code: 'not_authenticated', message: 'hello first' } });
        return;
      }
      const source = msg.payload.source === 'dm' ? 'dm' : 'room';
      const messageId = sanitizeRoomId(String(msg.payload.messageId ?? ''));
      const targetRoomId = typeof msg.payload.targetRoomId === 'string' ? sanitizeRoomId(msg.payload.targetRoomId) : '';
      const targetUserId = typeof msg.payload.targetUserId === 'string' ? String(msg.payload.targetUserId) : '';
      if (!messageId || (!targetRoomId && !targetUserId) || (targetRoomId && targetUserId)) {
        send(conn.socket, {
          type: 'error',
          payload: { code: 'invalid_input', message: 'forward requires exactly one target' },
        });
        return;
      }

      // 源消息可见性：房间消息须为源房间成员；私聊须为对话双方
      let srcText: string;
      let srcKind: 'text' | 'image';
      let srcMediaUrl: string | null;
      let label: string;
      if (source === 'room') {
        const found = await db.query<{ username: string; text: string; kind: string; media_url: string | null; room_name: string }>(
          `SELECT m.username, m.text, m.kind, m.media_url, r.name AS room_name
           FROM messages m JOIN rooms r ON r.id = m.room_id
           WHERE m.id = $1 AND m.recalled = false`,
          [messageId],
        );
        const row = found.rows[0];
        if (!row) {
          send(conn.socket, { type: 'error', payload: { code: 'message_not_found', message: 'message not found' } });
          return;
        }
        const member = await db.query('SELECT 1 FROM room_members WHERE room_id = (SELECT room_id FROM messages WHERE id = $1) AND user_id = $2', [
          messageId,
          conn.userId,
        ]);
        if (member.rows.length === 0) {
          send(conn.socket, { type: 'error', payload: { code: 'not_in_room', message: 'you cannot see this message' } });
          return;
        }
        srcText = row.text;
        srcKind = row.kind === 'image' ? 'image' : 'text';
        srcMediaUrl = row.media_url;
        label = `来自 ${row.room_name} · ${row.username}`;
      } else {
        const found = await db.query<{ username: string; text: string; kind: string; media_url: string | null; sender_id: string; recipient_id: string }>(
          'SELECT username, text, kind, media_url, sender_id, recipient_id FROM dm_messages WHERE id = $1 AND recalled = false',
          [messageId],
        );
        const row = found.rows[0];
        if (!row) {
          send(conn.socket, { type: 'error', payload: { code: 'message_not_found', message: 'message not found' } });
          return;
        }
        if (row.sender_id !== conn.userId && row.recipient_id !== conn.userId) {
          send(conn.socket, { type: 'error', payload: { code: 'not_in_room', message: 'you cannot see this message' } });
          return;
        }
        srcText = row.text;
        srcKind = row.kind === 'image' ? 'image' : 'text';
        srcMediaUrl = row.media_url;
        label = `来自 ${row.username} 的私聊`;
      }
      if (!srcText && !srcMediaUrl) {
        send(conn.socket, { type: 'error', payload: { code: 'empty_message', message: 'nothing to forward' } });
        return;
      }

      if (targetRoomId) {
        // 转发进房间 = 在该房间发一条新消息：成员资格 + 禁言约束一致
        const member = await db.query('SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2', [
          targetRoomId,
          conn.userId,
        ]);
        if (member.rows.length === 0) {
          send(conn.socket, { type: 'error', payload: { code: 'not_in_room', message: 'not in room', roomId: targetRoomId } });
          return;
        }
        const muted = await db.query('SELECT 1 FROM room_mutes WHERE room_id = $1 AND user_id = $2 AND muted_until > now()', [
          targetRoomId,
          conn.userId,
        ]);
        if (muted.rows.length > 0) {
          send(conn.socket, { type: 'error', payload: { code: 'muted', message: 'you are muted in this room', roomId: targetRoomId } });
          return;
        }
        const inserted = await db.query<{ id: string; created_at: string }>(
          `INSERT INTO messages (room_id, user_id, username, text, mentions, kind, media_url, forwarded_from_label)
           VALUES ($1, $2, $3, $4, '[]'::jsonb, $5, $6, $7) RETURNING id, created_at`,
          [targetRoomId, conn.userId, conn.username, srcText, srcKind, srcMediaUrl, label],
        );
        const row = inserted.rows[0];
        const message: ChatMessage = {
          id: row.id,
          roomId: targetRoomId,
          userId: conn.userId,
          username: conn.username,
          avatarUrl: conn.avatarUrl,
          text: srcText,
          createdAt: row.created_at,
          mentions: [],
          kind: srcKind,
          mediaUrl: srcMediaUrl ? `${conn.httpBase}${srcMediaUrl}` : null,
          forwardedFromLabel: label,
        };
        broadcastToRoom(targetRoomId, { type: 'message:new', payload: { roomId: targetRoomId, message } });
      } else {
        // 转发给好友 = 私聊新消息：好友关系校验与 dm:send 一致
        const friend = await db.query(
          `SELECT 1 FROM friendships
           WHERE status = 'accepted'
             AND ((requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1))`,
          [conn.userId, targetUserId],
        );
        if (friend.rows.length === 0) {
          send(conn.socket, { type: 'error', payload: { code: 'not_friends', message: '仅好友之间可以私聊' } });
          return;
        }
        const inserted = await db.query<{ id: string; created_at: string }>(
          `INSERT INTO dm_messages (sender_id, recipient_id, username, text, kind, media_url, forwarded_from_label)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, created_at`,
          [conn.userId, targetUserId, conn.username, srcText, srcKind, srcMediaUrl, label],
        );
        const row = inserted.rows[0];
        const message: DmMessage = {
          id: row.id,
          from: conn.userId,
          to: targetUserId,
          username: conn.username,
          avatarUrl: conn.avatarUrl,
          text: srcText,
          createdAt: row.created_at,
          kind: srcKind,
          mediaUrl: srcMediaUrl ? `${conn.httpBase}${srcMediaUrl}` : null,
          recalled: false,
          forwardedFromLabel: label,
        };
        sendToUser(conn.userId, { type: 'dm:new', payload: { message } });
        sendToUser(targetUserId, { type: 'dm:new', payload: { message } });
      }
      break;
    }
    case 'screen:start': {
      // 屏幕共享开始：仅房间成员可发起；通知房间内所有人（含自己作为确认）
      if (!conn.userId) {
        send(conn.socket, { type: 'error', payload: { code: 'not_authenticated', message: 'hello first' } });
        return;
      }
      const roomId = sanitizeRoomId(msg.payload.roomId);
      const member = await db.query('SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2', [roomId, conn.userId]);
      if (member.rows.length === 0 || !conn.rooms.has(roomId)) {
        send(conn.socket, { type: 'error', payload: { code: 'not_in_room', message: 'not in room', roomId } });
        return;
      }
      broadcastToRoom(roomId, {
        type: 'screen:started',
        payload: { roomId, userId: conn.userId, username: conn.username },
      });
      break;
    }

    case 'screen:stop': {
      if (!conn.userId) {
        send(conn.socket, { type: 'error', payload: { code: 'not_authenticated', message: 'hello first' } });
        return;
      }
      const roomId = sanitizeRoomId(msg.payload.roomId);
      if (!conn.rooms.has(roomId)) {
        send(conn.socket, { type: 'error', payload: { code: 'not_in_room', message: 'not in room', roomId } });
        return;
      }
      broadcastToRoom(roomId, { type: 'screen:stopped', payload: { roomId } });
      break;
    }

    case 'screen:signal': {
      // WebRTC 信令透传：仅转发给同房间指定成员；服务端不解析 SDP
      if (!conn.userId) {
        send(conn.socket, { type: 'error', payload: { code: 'not_authenticated', message: 'hello first' } });
        return;
      }
      const roomId = sanitizeRoomId(msg.payload.roomId);
      const targetId = String(msg.payload.to ?? '');
      if (!conn.rooms.has(roomId)) {
        send(conn.socket, { type: 'error', payload: { code: 'not_in_room', message: 'not in room', roomId } });
        return;
      }
      const both = await db.query(
        `SELECT 1 FROM room_members WHERE room_id = $1 AND user_id IN ($2, $3) LIMIT 2`,
        [roomId, conn.userId, targetId],
      );
      if (Number(both.rows.length) !== 2) {
        send(conn.socket, { type: 'error', payload: { code: 'not_in_room', message: 'target not in room', roomId } });
        return;
      }
      sendToUser(targetId, { type: 'screen:signal', payload: { from: conn.userId, data: msg.payload.data } });
      break;
    }

    case 'ping': {
      send(conn.socket, { type: 'pong' });
      break;
    }
    default: {
      send(conn.socket, { type: 'error', payload: { code: 'unknown_type', message: 'unknown message type' } });
    }
  }
}
