// 客户端与服务端共享的消息协议类型（与 server/src/ws/gateway.ts 对应）

export interface UserBrief {
  id: string;
  username: string;
  avatarUrl?: string | null;
}

export interface ChatMessage {
  id: string;
  roomId: string;
  userId: string;
  username: string;
  avatarUrl?: string | null;
  text: string;
  createdAt: string;
  /** 客户端本地字段：乐观发送未确认时标记（真实服务器消息无此字段） */
  pending?: boolean;
}

// 客户端 -> 服务端
export type ClientWsMessage =
  | { type: 'hello'; payload: { token: string } }
  | { type: 'room:join'; payload: { roomId: string } }
  | { type: 'room:leave'; payload: { roomId: string } }
  | { type: 'room:delete'; payload: { roomId: string } }
  | { type: 'member:kick'; payload: { roomId: string; userId: string } }
  | { type: 'message:send'; payload: { roomId: string; text: string } }
  | { type: 'ping' };

// 服务端 -> 客户端
export type ServerWsMessage =
  | { type: 'hello:ok'; payload: { me: UserBrief } }
  | { type: 'room:joined'; payload: { roomId: string; members: UserBrief[] } }
  | { type: 'member:joined'; payload: { roomId: string; member: UserBrief } }
  | { type: 'member:left'; payload: { roomId: string; userId: string; username: string } }
  | { type: 'member:kicked'; payload: { roomId: string; userId: string; username: string } }
  | { type: 'message:new'; payload: { roomId: string; message: ChatMessage } }
  | { type: 'room:deleted'; payload: { roomId: string } }
  | { type: 'error'; payload: { code: string; message: string; roomId?: string } }
  | { type: 'pong' };

export type WsStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';
