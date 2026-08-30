-- 消息转发来源快照：纯展示用（如「来自 群A · 张三」），不参与任何权限判断
ALTER TABLE messages ADD COLUMN IF NOT EXISTS forwarded_from_label TEXT;
ALTER TABLE dm_messages ADD COLUMN IF NOT EXISTS forwarded_from_label TEXT;
