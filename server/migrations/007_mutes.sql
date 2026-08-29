-- 007_mutes.sql: 房间禁言（房主对成员限时禁言，到期自动失效，惰性清理）
CREATE TABLE IF NOT EXISTS room_mutes (
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  muted_until TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_room_mutes_until ON room_mutes (muted_until);
