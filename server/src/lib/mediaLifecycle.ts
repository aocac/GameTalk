import type { QueryResultRow } from 'pg';
import type { Db } from '../db/db.js';

/** 消息/表情里登记的相对路径前缀，与 GET /api/media/:id 对齐 */
export const MEDIA_URL_PREFIX = '/api/media/';

export function mediaPathOf(id: string): string {
  return `${MEDIA_URL_PREFIX}${id}`;
}

interface SumRow extends QueryResultRow {
  used: string | number | null;
}

interface IdRow extends QueryResultRow {
  id: string;
}

/** 某用户当前占用的图片字节数（含尚未挂到消息上的待发图） */
export async function mediaUsageOf(db: Db, ownerId: string): Promise<number> {
  const res = await db.query<SumRow>(
    'SELECT COALESCE(SUM(octet_length(bytes)), 0) AS used FROM media WHERE owner_id = $1',
    [ownerId],
  );
  return Number(res.rows[0]?.used ?? 0);
}

/**
 * 清掉「过了 TTL 且没有任何引用」的图片：未发出的待发图、已撤回清空引用的图。
 * 表情包（个人/群）引用的媒体不删。cutoff 之前创建的才参与。
 * 返回删除条数。
 */
export async function sweepUnusedMedia(db: Db, cutoff: Date): Promise<number> {
  const res = await db.query<IdRow>(
    `DELETE FROM media m
     WHERE m.created_at < $1
       AND NOT EXISTS (SELECT 1 FROM user_stickers s WHERE s.media_id = m.id)
       AND NOT EXISTS (SELECT 1 FROM room_stickers s WHERE s.media_id = m.id)
       AND NOT EXISTS (
         SELECT 1 FROM messages msg
         WHERE msg.media_url = $2 || m.id::text
            OR msg.media_urls @> jsonb_build_array($2 || m.id::text)
       )
       AND NOT EXISTS (
         SELECT 1 FROM dm_messages msg
         WHERE msg.media_url = $2 || m.id::text
            OR msg.media_urls @> jsonb_build_array($2 || m.id::text)
       )
     RETURNING m.id`,
    [cutoff.toISOString(), MEDIA_URL_PREFIX],
  );
  return res.rowCount ?? res.rows.length;
}

export function mediaQuotaExceededMessage(quotaBytes: number): string {
  const mb = Math.max(1, Math.round(quotaBytes / (1024 * 1024)));
  return `图片存储已达上限（${mb}MB/人），请删掉一些表情或等未使用的图片过期后再试`;
}
