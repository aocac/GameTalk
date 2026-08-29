-- 010_dm_messages.sql: 好友私聊（DM，一对一）
-- 与房间消息（messages）分离：无房间/禁言/提及语义；仅好友可收发（好友关系校验在服务层）。
-- 删除好友不删除历史（重新加好友后消息仍在，QQ 式行为）。
CREATE TABLE IF NOT EXISTS dm_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- username 冗余快照：用户改名后旧消息保留当时的名字
  username TEXT NOT NULL,
  text TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'text',
  media_url TEXT,
  reply_to UUID REFERENCES dm_messages(id) ON DELETE SET NULL,
  recalled BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (sender_id <> recipient_id)
);

-- 会话对查询：(sender=$1 AND recipient=$2) OR (sender=$2 AND recipient=$1)
-- 两个单列方向索引供 planner bitmap-or 使用，再按对过滤
CREATE INDEX IF NOT EXISTS idx_dm_sender_created ON dm_messages (sender_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dm_recipient_created ON dm_messages (recipient_id, created_at DESC);
