-- 009_replies.sql: 引用回复（消息内嵌引用块，微信/QQ 式）
-- reply_to 指向同房间原消息；删除原消息时置空（渲染层靠发送时快照兜底）
ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to UUID REFERENCES messages(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_messages_reply_to ON messages (reply_to);
