import type { FastifyInstance } from 'fastify';
import type { RawData, WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';

/**
 * Phase 2：最小实时通信闭环（内存房间表，无持久化）。
 * Phase 3 将在此加入 JWT 认证（hello 携带 token 替代 name）。
 * Phase 4 将消息持久化到 PostgreSQL。
 */

const MAX_TEXT_LENGTH = 2000;

interface Conn {
  socket: WebSocket;
  userId: string;
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
  | { type: 'hello'; payload: { name: string } }
  | { type: 'room:join'; payload: { roomId: string } }
  | { type: 'room:leave'; payload: { roomId: string } }
  | { type: 'message:send'; payload: { roomId: string; text: string } }
  | { type: 'ping' };

const conns = new Map<WebSocket, Conn>();
const rooms = new Map<string, Set<WebSocket>>();
const roomMembers = new Map<string, Map<string, Conn>>(); // roomId -> userId -> conn

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

function sendToRoom(roomId: string, msg: unknown, except?: WebSocket): void {
  const members = roomMembers.get(roomId);
  if (!members) return;
  for (const conn of members.values()) {
    if (conn.socket !== except) send(conn.socket, msg);
  }
}

function joinRoom(conn: Conn, roomId: string): void {
  if (conn.rooms.has(roomId)) return;
  conn.rooms.add(roomId);
  let members = roomMembers.get(roomId);
  if (!members) {
    members = new Map();
    roomMembers.set(roomId, members);
  }
  members.set(conn.userId, conn);

  send(conn.socket, {
    type: 'room:joined',
    payload: {
      roomId,
      members: [...members.values()].map((c) => ({ id: c.userId, username: c.username })),
    },
  });
  sendToRoom(
    roomId,
    { type: 'member:joined', payload: { roomId, member: { id: conn.userId, username: conn.username } } },
    conn.socket,
  );
}

function leaveRoom(conn: Conn, roomId: string): void {
  if (!conn.rooms.delete(roomId)) return;
  const members = roomMembers.get(roomId);
  if (members) {
    members.delete(conn.userId);
    if (members.size === 0) roomMembers.delete(roomId);
  }
  sendToRoom(
    roomId,
    { type: 'member:left', payload: { roomId, userId: conn.userId, username: conn.username } },
    conn.socket,
  );
}

function handleMessage(conn: Conn, raw: RawData): void {
  let msg: ClientMessage;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    send(conn.socket, { type: 'error', payload: { code: 'bad_json', message: 'invalid message' } });
    return;
  }

  switch (msg.type) {
    case 'hello': {
      const name = msg.payload.name.trim().slice(0, 32) || 'Player';
      conn.username = name;
      send(conn.socket, {
        type: 'hello:ok',
        payload: { me: { id: conn.userId, username: conn.username } },
      });
      break;
    }
    case 'room:join': {
      joinRoom(conn, sanitizeRoomId(msg.payload.roomId));
      break;
    }
    case 'room:leave': {
      leaveRoom(conn, sanitizeRoomId(msg.payload.roomId));
      break;
    }
    case 'message:send': {
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
      sendToRoom(roomId, { type: 'message:new', payload: { roomId, message } });
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

export function registerWsRoutes(app: FastifyInstance): void {
  app.get('/ws', { websocket: true }, (socket) => {
    const conn: Conn = {
      socket,
      userId: randomUUID(),
      username: 'Player',
      rooms: new Set(),
    };
    conns.set(socket, conn);

    socket.on('message', (raw) => handleMessage(conn, raw));
    socket.on('close', () => {
      for (const roomId of [...conn.rooms]) leaveRoom(conn, roomId);
      conns.delete(socket);
    });
    socket.on('error', () => {
      for (const roomId of [...conn.rooms]) leaveRoom(conn, roomId);
      conns.delete(socket);
    });
  });
}
