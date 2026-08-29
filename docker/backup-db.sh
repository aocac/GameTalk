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
chmod 755 "$BACKUP_DIR"   # 目录需可进入：异地副本由 ubuntu 账户经 scp 拉取

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
#    （含密钥，保持 root-only，仅作服务器本地副本；异地只拉数据库 dump）
tar czf "$cfg" -C "$REPO_ROOT" docker/docker-compose.yml docker/.env
chmod 600 "$cfg"
chmod 644 "$dump"

# 4) 轮转：保留最近 KEEP_DAYS 天
find "$BACKUP_DIR" -name 'gametalk-db-*.dump' -mtime +"$KEEP_DAYS" -delete
find "$BACKUP_DIR" -name 'configs-*.tar.gz' -mtime +"$KEEP_DAYS" -delete

size=$(du -h "$dump" | cut -f1)
log "✅ 完成：$dump ($size, TOC $toc_lines 行) + $cfg；保留 ${KEEP_DAYS} 天"
