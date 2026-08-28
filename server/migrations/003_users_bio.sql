-- 003_users_bio.sql: 个性签名（个人资料 / 成员卡片展示）
ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT;
