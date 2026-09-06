-- 一条消息多张图片：media_urls JSONB 数组（与既有单图 media_url 并存）。
-- 服务端写入时同步维护 media_url = 首图，旧客户端只渲染首图不受影响；
-- 新客户端渲染 media_urls 网格。
ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_urls JSONB;
ALTER TABLE dm_messages ADD COLUMN IF NOT EXISTS media_urls JSONB;
