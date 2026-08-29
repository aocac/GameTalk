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
}

interface MentionRef {
  id: string;
  username: string;
}

/** 房间花名册成员 = 全体 DB 成员 + 当前在线标记（QQ 式：离线成员也展示，灰头像） */
interface RosterMember {
  id: string;
  username: string;
  avatarUrl: string | null;
  online: boolean;
}

type ClientMessage =
  | { type: 'hello'; payload: { token: string } }
  | { type: 'room:join'; payload: { roomId: string } }
  | { type: 'room:leave'; payload: { roomId: string } }
  | { type: 'room:delete'; payload: { roomId: string } }
  | { type: 'member:kick'; payload: { roomId: string; userId: string } }
  | { type: 'message:send'; payload: { roomId: string; text: string; mentions?: unknown } }
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

/** 花名册：DB 全体成员（按加入时间）+ 内存连接表推导的在线标记 */
async function roomRosterOf(db: Db, roomId: string, httpBase: string): Promise<RosterMember[]> {
  const res = await db.query<{ id: string; username: string; avatar_url: string | null }>(
    `SELECT u.id, u.username, u.avatar_url
     FROM room_members rm JOIN users u ON u.id = rm.user_id
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
    case 'message:send': {
      if (!conn.userId) {
        send(conn.socket, { type: 'error', payload: { code: 'not_authenticated', message: 'hello first' } });
        return;
      }
      const roomId = sanitizeRoomId(msg.payload.roomId);
      const text = safeText(msg.payload.text);
      if (!text) {
        send(conn.socket, { type: 'error', payload: { code: 'empty_message', message: 'message is empty' } });
        return;
      }
      if (!conn.rooms.has(roomId)) {
        send(conn.socket, { type: 'error', payload: { code: 'not_in_room', message: 'not in room', roomId } });
        return;
      }
      // 持久化后再广播（Phase 4：消息历史；v0.4.0：提及解析入库）
      const mentions = await resolveMentions(db, roomId, conn.userId, text, msg.payload.mentions);
      const inserted = await db.query<{ id: string; created_at: string; mentions: MentionRef[] }>(
        'INSERT INTO messages (room_id, user_id, username, text, mentions) VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING id, created_at, mentions',
        [roomId, conn.userId, conn.username, text, JSON.stringify(mentions)],
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
      };
      broadcastToRoom(roomId, { type: 'message:new', payload: { roomId, message } });
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
