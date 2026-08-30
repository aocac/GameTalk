// 客户端与服务端共享的消息协议类型（与 server/src/ws/gateway.ts 对应）

export interface UserBrief {
  id: string;
  username: string;
  avatarUrl?: string | null;
}

/** 房间花名册成员：全体 DB 成员 + 在线标记（离线成员保留在列表，QQ 式置灰） */
export interface RoomMember extends UserBrief {
  online: boolean;
  /** 生效中的禁言截止时间（ISO；null/undefined = 未被禁言） */
  mutedUntil?: string | null;
}

/** 好友/申请条目里的公开资料 */
export interface FriendProfile extends UserBrief {
  bio?: string | null;
}

/** 消息内的提及快照 */
export interface MentionRef {
  id: string;
  username: string;
}

/** 引用回复快照（随消息入库/广播，渲染不依赖原消息仍在历史窗口内） */
export interface ReplyRef {
  id: string;
  username: string;
  text: string;
  kind: 'text' | 'image' | 'sticker';
}

export interface ChatMessage {
  id: string;
  roomId: string;
  userId: string;
  username: string;
  avatarUrl?: string | null;
  text: string;
  createdAt: string;
  mentions?: MentionRef[];
  /** 'image' 时 mediaUrl 指向图片（广播为绝对 URL，乐观期为相对路径） */
  kind?: 'text' | 'image' | 'sticker';
  mediaUrl?: string | null;
  /** 引用回复的原消息快照 */
  reply?: ReplyRef;
  /** 已撤回：内容已清空，渲染占位文案 */
  recalled?: boolean;
  /** 编辑时间（ISO；仅编辑过的消息携带） */
  editedAt?: string;
  /** 撤回操作者（房主代撤时与作者不同；旧数据/旧服务端无此字段，渲染回落消息作者） */
  recalledBy?: { id: string; username: string };
  /** 转发来源快照（纯展示，如「来自 群A · 张三」） */
  forwardedFromLabel?: string | null;
  /** 客户端本地字段：乐观发送未确认时标记（真实服务器消息无此字段） */
  pending?: boolean;
}

/** 好友私聊消息（from/to 表达会话方向；渲染字段与房间消息对齐） */
export interface DmMessage {
  id: string;
  from: string;
  to: string;
  username: string;
  avatarUrl?: string | null;
  text: string;
  createdAt: string;
  kind?: 'text' | 'image' | 'sticker';
  mediaUrl?: string | null;
  reply?: ReplyRef;
  recalled?: boolean;
  /** 编辑时间（ISO；仅编辑过的消息携带） */
  editedAt?: string;
  /** 转发来源快照（纯展示，如「来自 群A · 张三」） */
  forwardedFromLabel?: string | null;
}

// 客户端 -> 服务端
export type ClientWsMessage =
  | { type: 'hello'; payload: { token: string } }
  | { type: 'room:join'; payload: { roomId: string } }
  | { type: 'room:leave'; payload: { roomId: string } }
  | { type: 'room:delete'; payload: { roomId: string } }
  | { type: 'member:kick'; payload: { roomId: string; userId: string } }
  | { type: 'member:mute'; payload: { roomId: string; userId: string; minutes: number } }
  | { type: 'member:unmute'; payload: { roomId: string; userId: string } }
  | { type: 'message:send'; payload: { roomId: string; text: string; mentions?: string[]; mediaUrl?: string; replyTo?: string; kind?: 'sticker' } }
  | { type: 'message:recall'; payload: { roomId: string; messageId: string } }
  | { type: 'message:edit'; payload: { roomId: string; messageId: string; text: string } }
  | { type: 'dm:send'; payload: { to: string; text: string; mediaUrl?: string; replyTo?: string; kind?: 'sticker' } }
  | { type: 'dm:recall'; payload: { messageId: string } }
  | { type: 'dm:edit'; payload: { messageId: string; text: string } }
  | {
      type: 'message:forward';
      payload: { source: 'room' | 'dm'; messageId: string; targetRoomId?: string; targetUserId?: string };
    }
  | { type: 'screen:start'; payload: { roomId: string } }
  | { type: 'screen:stop'; payload: { roomId: string } }
  | { type: 'screen:signal'; payload: { roomId: string; to: string; data: unknown } }
  | { type: 'ping' };

// 服务端 -> 客户端
export type ServerWsMessage =
  | { type: 'hello:ok'; payload: { me: UserBrief } }
  | { type: 'room:joined'; payload: { roomId: string; members: RoomMember[] } }
  | { type: 'member:joined'; payload: { roomId: string; member: UserBrief } }
  | { type: 'member:left'; payload: { roomId: string; userId: string; username: string } }
  | { type: 'member:kicked'; payload: { roomId: string; userId: string; username: string } }
  | { type: 'member:muted'; payload: { roomId: string; userId: string; mutedUntil: string } }
  | { type: 'member:unmuted'; payload: { roomId: string; userId: string } }
  | { type: 'message:new'; payload: { roomId: string; message: ChatMessage } }
  | { type: 'message:recalled'; payload: { roomId: string; messageId: string; operatorId?: string; operatorUsername?: string } }
  | { type: 'message:edited'; payload: { roomId: string; messageId: string; text: string; editedAt: string } }
  | { type: 'room:deleted'; payload: { roomId: string } }
  | { type: 'friend:request'; payload: { requestId: string; from: FriendProfile } }
  | { type: 'dm:new'; payload: { message: DmMessage } }
  | { type: 'dm:recalled'; payload: { messageId: string; from: string; to: string } }
  | { type: 'dm:edited'; payload: { messageId: string; from: string; to: string; text: string; editedAt: string } }
  | { type: 'friend:accepted'; payload: { user: FriendProfile } }
  | { type: 'friend:declined'; payload: { userId: string } }
  | { type: 'friend:removed'; payload: { userId: string } }
  | { type: 'presence:friend'; payload: { userId: string; online: boolean } }
  | { type: 'screen:started'; payload: { roomId: string; userId: string; username: string } }
  | { type: 'screen:stopped'; payload: { roomId: string } }
  | { type: 'screen:signal'; payload: { from: string; data: unknown } }
  | { type: 'error'; payload: { code: string; message: string; roomId?: string; mutedUntil?: string; to?: string; from?: string } }
  | { type: 'pong' };

export type WsStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';
