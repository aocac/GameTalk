#!/usr/bin/env bash
# GameTalk 数据库每日备份（在 VPS 上以 root 运行，通常由 gametalk-backup.timer 调度）
# 内容：pg_dump 自定义格式全量 + compose/.env 配置快照 + pg_restore 完整性校验 + 轮转
# 手动执行：sudo bash /root/gametalk/docker/backup-db.sh
set -euo pipefail

REPO_ROOT="${REPO_ROOT:-/root/gametalk}"
BACKUP_DIR="${BACKUP_DIR:-$REPO_ROOT/backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
PG_CONTAINER="${PG_CONTAINER:-docker-postgres-1}"
PG_USER="${PG_USER:-gametalk}"
PG_DB="${PG_DB:-gametalk}"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

# 防重叠：上一次尚未结束时直接跳过（flock 不等待）
exec 9>"$BACKUP_DIR/.lock"
flock -n 9 || { echo "[backup] 已有备份在执行，跳过"; exit 0; }

log() { echo "[$(date '+%F %T')] $*" | tee -a "$BACKUP_DIR/backup.log"; }
trap 'log "❌ 备份失败（退出码 $?）"' ERR

ts="$(date +%Y%m%d-%H%M%S)"
dump="$BACKUP_DIR/gametalk-db-$ts.dump"
cfg="$BACKUP_DIR/configs-$ts.tar.gz"

# 1) 全量转储（容器内 socket 信任认证，无需密码）
log "开始备份：pg_dump $PG_DB → $dump"
docker exec "$PG_CONTAINER" pg_dump -U "$PG_USER" -Fc "$PG_DB" > "$dump"

# 2) 完整性校验：pg_restore 必须能读出目录（TOC），否则丢弃坏 dump 并报错
toc_file="$BACKUP_DIR/.toc.tmp"
if ! docker exec -i "$PG_CONTAINER" pg_restore -l < "$dump" > "$toc_file" 2>&1; then
  rm -f "$dump" "$toc_file"
  log "❌ pg_restore -l 校验失败，已丢弃本次 dump"
  exit 1
fi
toc_lines=$(wc -l < "$toc_file")
rm -f "$toc_file"
if [ "$toc_lines" -lt 2 ]; then
  rm -f "$dump"
  log "❌ TOC 条目异常（$toc_lines 行），已丢弃本次 dump"
  exit 1
fi

# 3) 配置快照：自定义 compose 与 .env 同样只存在于本机盘，一并纳入备份
#    （含密钥，root-only 仅作服务器本地副本；异地副本经 sudo 通道拉取 dump）
tar czf "$cfg" -C "$REPO_ROOT" docker/docker-compose.yml docker/.env
chmod 600 "$cfg"

# 4) 轮转：保留最近 KEEP_DAYS 天
find "$BACKUP_DIR" -name 'gametalk-db-*.dump' -mtime +"$KEEP_DAYS" -delete
find "$BACKUP_DIR" -name 'configs-*.tar.gz' -mtime +"$KEEP_DAYS" -delete

size=$(du -h "$dump" | cut -f1)
log "✅ 完成：$dump ($size, TOC $toc_lines 行) + $cfg；保留 ${KEEP_DAYS} 天"

# 5) 可选：推到 S3 兼容对象存储（AWS / COS / OSS / MinIO）。未配置四项凭据则跳过。
#    失败不回滚本地 dump——对象存储是额外的冷备，不能因为远端故障丢掉本机备份。
if [ -f "$REPO_ROOT/docker/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$REPO_ROOT/docker/.env"
  set +a
fi

upload_s3() {
  local file="$1"
  if [ -z "${BACKUP_S3_ENDPOINT:-}" ] || [ -z "${BACKUP_S3_BUCKET:-}" ] \
    || [ -z "${BACKUP_S3_ACCESS_KEY:-}" ] || [ -z "${BACKUP_S3_SECRET_KEY:-}" ]; then
    return 0
  fi
  local server="${SERVER_CONTAINER:-docker-server-1}"
  local remote="/tmp/gt-s3-$(basename "$file")"
  if ! docker cp "$file" "$server:$remote" 2>/dev/null; then
    log "⚠ 对象存储：无法把文件拷进 $server，跳过 $(basename "$file")"
    return 0
  fi
  if docker exec \
      -e BACKUP_S3_ENDPOINT -e BACKUP_S3_BUCKET \
      -e BACKUP_S3_ACCESS_KEY -e BACKUP_S3_SECRET_KEY \
      -e BACKUP_S3_REGION -e BACKUP_S3_PREFIX -e BACKUP_S3_PATH_STYLE \
      "$server" node dist/cli/push-backup.js "$remote" "$(basename "$file")"; then
    log "✅ 已上传到对象存储：$(basename "$file")"
  else
    log "⚠ 对象存储上传失败（本地 dump 仍保留）：$(basename "$file")"
  fi
  docker exec "$server" rm -f "$remote" >/dev/null 2>&1 || true
}

if [ -n "${BACKUP_S3_BUCKET:-}" ]; then
  upload_s3 "$dump"
  upload_s3 "$cfg"
else
  log "对象存储未配置（BACKUP_S3_*），仅保留本地 dump"
fi
