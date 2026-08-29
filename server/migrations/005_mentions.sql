-- 005_mentions.sql: 消息 @提及（存 {id, username} 快照，历史渲染不依赖成员表）
ALTER TABLE messages ADD COLUMN IF NOT EXISTS mentions JSONB NOT NULL DEFAULT '[]';

CREATE INDEX IF NOT EXISTS idx_messages_mentions ON messages USING gin (mentions);
