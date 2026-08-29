-- 008_recalled.sql: 消息撤回（发送者本人或房主；撤回后内容清空，仅留占位）
ALTER TABLE messages ADD COLUMN IF NOT EXISTS recalled BOOLEAN NOT NULL DEFAULT false;
