import type { FastifyInstance } from 'fastify';
import type { RawData, WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
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
  rooms: Set<string>;
}

interface ChatMessage {
  id: string;
  roomId: string;
  userId: string;
  username: string;
  text: string;
  createdAt: string;
}

type ClientMessage =
  | { type: 'hello'; payload: { token: string } }
  | { type: 'room:join'; payload: { roomId: string } }
  | { type: 'room:leave'; payload: { roomId: string } }
  | { type: 'message:send'; payload: { roomId: string; text: string } }
  | { type: 'ping' };

interface UserRow extends QueryResultRow {
  id: string;
  username: string;
}

/** roomId -> userId -> { username, sockets }（同一用户可能多端连接） */
const rooms = new Map<string, Map<string, { username: string; sockets: Set<WebSocket> }>>();

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

function publicMember(userId: string, username: string) {
  return { id: userId, username };
}

function joinRoom(conn: Conn, roomId: string): void {
  if (!conn.userId) return;
  if (conn.rooms.has(roomId)) return;
  conn.rooms.add(roomId);

  let members = rooms.get(roomId);
  if (!members) {
    members = new Map();
    rooms.set(roomId, members);
  }
  let entry = members.get(conn.userId);
  const isNewMember = !entry;
  if (!entry) {
    entry = { username: conn.username, sockets: new Set() };
    members.set(conn.userId, entry);
  }
  entry.sockets.add(conn.socket);

  send(conn.socket, {
    type: 'room:joined',
    payload: {
      roomId,
      members: [...members.entries()].map(([uid, e]) => publicMember(uid, e.username)),
    },
  });
  if (isNewMember) {
    broadcastToRoom(
      roomId,
      { type: 'member:joined', payload: { roomId, member: publicMember(conn.userId, conn.username) } },
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
      rooms: new Set(),
    };

    socket.on('message', (raw: RawData) => {
      void handleMessage(conn, raw, db, jwt);
    });
    socket.on('close', () => {
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
          const found = await db.query<UserRow>('SELECT id, username FROM users WHERE id = $1', [payload.sub]);
          const user = found.rows[0];
          if (!user) throw new Error('user not found');
          conn.userId = user.id;
          conn.username = user.username;
          send(conn.socket, { type: 'hello:ok', payload: { me: publicMember(user.id, user.username) } });
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
      joinRoom(conn, sanitizeRoomId(msg.payload.roomId));
      break;
    }
    case 'room:leave': {
      leaveRoom(conn, sanitizeRoomId(msg.payload.roomId));
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
      const message: ChatMessage = {
        id: randomUUID(),
        roomId,
        userId: conn.userId,
        username: conn.username,
        text,
        createdAt: new Date().toISOString(),
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
