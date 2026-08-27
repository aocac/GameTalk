import type { FastifyInstance } from 'fastify';
import type { RawData, WebSocket } from 'ws';
import type { QueryResultRow } from 'pg';
import type { Config } from '../config.js';
import type { Db } from '../db/db.js';
import type { JwtService } from '../lib/jwt.js';

/**
 * WebSocket 网关（Phase 3+）：JWT 认证 + 内存房间表。
 * - hello 携带 token，认证成功后绑定用户
 * - 房间成员按 userId 去重（同一用户可多连接，广播到其所有 socket）
 * - 消息广播实时分发；持久化在 Phase 4 加入
 */

const MAX_TEXT_LENGTH = 2000;

interface Conn {
  socket: WebSocket;
  userId: string | null;
  username: string;
  avatarUrl: string | null;
  rooms: Set<string>;
}

interface ChatMessage {
  id: string;
  roomId: string;
  userId: string;
  username: string;
  avatarUrl: string | null;
  text: string;
  createdAt: string;
}

type ClientMessage =
  | { type: 'hello'; payload: { token: string } }
  | { type: 'room:join'; payload: { roomId: string } }
  | { type: 'room:leave'; payload: { roomId: string } }
  | { type: 'room:delete'; payload: { roomId: string } }
  | { type: 'message:send'; payload: { roomId: string; text: string } }
  | { type: 'ping' };

interface UserRow extends QueryResultRow {
  id: string;
  username: string;
  avatar_url: string | null;
}

/** roomId -> userId -> { username, avatarUrl, sockets }（同一用户可能多端连接） */
const rooms = new Map<string, Map<string, { username: string; avatarUrl: string | null; sockets: Set<WebSocket> }>>();

function sanitizeRoomId(id: string): string {
  return id.trim().slice(0, 64);
}

function safeText(text: string): string {
  return text.trim().slice(0, MAX_TEXT_LENGTH);
}

function send(socket: WebSocket, msg: unknown): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(msg));
  }
}

function sendToUser(roomId: string, userId: string, msg: unknown, except?: WebSocket): void {
  const entry = rooms.get(roomId)?.get(userId);
  if (!entry) return;
  for (const s of entry.sockets) {
    if (s !== except) send(s, msg);
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

function joinRoom(conn: Conn, roomId: string, avatarUrl?: string | null): void {
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

  send(conn.socket, {
    type: 'room:joined',
    payload: {
      roomId,
      members: [...members.entries()].map(([uid, e]) => publicMember(uid, e.username, e.avatarUrl)),
    },
  });
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

export function registerWsRoutes(app: FastifyInstance, deps: { config: Config; db: Db; jwt: JwtService }): void {
  const { db, jwt } = deps;

  app.get('/ws', { websocket: true }, (socket) => {
    const conn: Conn = {
      socket,
      userId: null,
      username: 'Player',
      avatarUrl: null,
      rooms: new Set(),
    };

    socket.on('message', (raw: RawData) => {
      void handleMessage(conn, raw, db, jwt);
    });    socket.on('close', () => {
      for (const roomId of [...conn.rooms]) leaveRoom(conn, roomId);
    });
    socket.on('error', () => {
      for (const roomId of [...conn.rooms]) leaveRoom(conn, roomId);
    });
  });
}

async function handleMessage(conn: Conn, raw: RawData, db: Db, jwt: JwtService): Promise<void> {
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
          conn.avatarUrl = user.avatar_url;
          send(conn.socket, { type: 'hello:ok', payload: { me: publicMember(user.id, user.username, user.avatar_url) } });
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
        send(conn.socket, { type: 'error', payload: { code: 'not_in_room', message: 'you are not a member of this room' } });
        return;
      }
      const avatar = await db.query<{ avatar_url: string | null }>('SELECT avatar_url FROM users WHERE id = $1', [
        conn.userId,
      ]);
      conn.avatarUrl = avatar.rows[0]?.avatar_url ?? null;
      joinRoom(conn, roomId, conn.avatarUrl);
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
        send(conn.socket, { type: 'error', payload: { code: 'not_in_room', message: 'not in room' } });
        return;
      }
      // 持久化后再广播（Phase 4：消息历史）
      const inserted = await db.query<{ id: string; created_at: string }>(
        'INSERT INTO messages (room_id, user_id, username, text) VALUES ($1, $2, $3, $4) RETURNING id, created_at',
        [roomId, conn.userId, conn.username, text],
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
