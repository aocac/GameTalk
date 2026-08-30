-- 邀请链接：房主/成员生成的可过期、可限次数的房间邀请
-- code 为 16 位长码（区别于 8 位房间邀请码，防猜测）；expires_at 为 NULL 表示永久有效
CREATE TABLE IF NOT EXISTS invite_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  code TEXT NOT NULL UNIQUE,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ,
  max_uses INT NOT NULL DEFAULT 0,
  used_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_invite_links_room ON invite_links(room_id);
