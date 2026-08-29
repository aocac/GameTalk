-- 011_edited.sql: 消息编辑
-- edited_at 非空 = 已编辑（展示「已编辑」小标）；编辑仅更新 text，原版本不保留（微信/QQ 式）。
-- 撤回与编辑互斥：撤回后不可编辑，编辑过的消息仍可撤回。
ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;
ALTER TABLE dm_messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;
