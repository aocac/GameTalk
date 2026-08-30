-- 013_stickers.sql: 云表情包（个人跨设备同步）+ 群共享表情库
-- 个人：user_stickers 按用户存储，跨设备同步（原客户端本地存储会随设备丢失）。
-- 群：room_stickers 房间级共享，成员共同贡献，全群可见。
-- media 复用现有图片上传/校验/服务链路（表情即图片，点选即发送）。
CREATE TABLE IF NOT EXISTS user_stickers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_id UUID NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner_id, media_id)
);

CREATE INDEX IF NOT EXISTS idx_user_stickers_owner ON user_stickers (owner_id, created_at);

CREATE TABLE IF NOT EXISTS room_stickers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  media_id UUID NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  added_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (room_id, media_id)
);

CREATE INDEX IF NOT EXISTS idx_room_stickers_room ON room_stickers (room_id, created_at);
