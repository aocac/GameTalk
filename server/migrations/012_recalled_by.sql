-- 012_recalled_by.sql: 记录撤回操作者
-- 房主可撤回群员消息：recalled_by 记录实际执行撤回的人（NULL = 旧数据，渲染回落消息作者）。
-- 撤回行文案据此刻画「XX撤回了 YY 的消息」。
ALTER TABLE messages ADD COLUMN IF NOT EXISTS recalled_by UUID REFERENCES users(id) ON DELETE SET NULL;
