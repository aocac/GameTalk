-- 017: 媒体按 owner 检索（配额统计）+ 好友关系无向唯一（A→B 与 B→A 不能并存）
--
-- 好友表原先 UNIQUE (requester_id, addressee_id) 只约束同一方向。
-- 反向并发申请（A→B 与 B→A 同时到达）会插入两行，列表/删除只命中其中一行。
-- 先按「已接受优先、更早优先」去重，再加无向唯一索引。

DELETE FROM friendships
WHERE id IN (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY LEAST(requester_id, addressee_id), GREATEST(requester_id, addressee_id)
             ORDER BY CASE WHEN status = 'accepted' THEN 0 ELSE 1 END, created_at ASC, id ASC
           ) AS rn
    FROM friendships
  ) ranked
  WHERE rn > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_friendships_pair
  ON friendships (LEAST(requester_id, addressee_id), GREATEST(requester_id, addressee_id));

CREATE INDEX IF NOT EXISTS idx_media_owner ON media (owner_id);
