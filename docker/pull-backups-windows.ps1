# GameTalk 异地备份拉取（在 Windows 管理机上运行；配合 VPS 上的 gametalk-backup.timer）
# 依赖：~/.ssh/config 中配置了 gametalk-vps 主机别名（私钥只存本机）
# 手动执行：powershell -ExecutionPolicy Bypass -File docker\pull-backups-windows.ps1
# 调度方式见 docs/deployment.md「数据库备份与恢复」
$ErrorActionPreference = "Stop"

$dest = Join-Path $env:USERPROFILE "GameTalkBackups"
New-Item -ItemType Directory -Force -Path $dest | Out-Null

$latestDump = (ssh -o BatchMode=yes gametalk-vps "ls -1t /root/gametalk/backups/gametalk-db-*.dump 2>/dev/null | head -n1")
if ([string]::IsNullOrWhiteSpace($latestDump)) {
    throw "VPS 上没有数据库备份：检查服务器 gametalk-backup.timer 是否已启用"
}
$latestDump = $latestDump.Trim()

Write-Host "拉取 $latestDump ..."
scp -q -o BatchMode=yes "gametalk-vps:$latestDump" $dest
# 说明：configs-*.tar.gz 含密钥且为 root-only，仅作服务器本地副本，不在此拉取

# 本地保留 90 天
Get-ChildItem $dest -File |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-90) } |
    Remove-Item -Force

Write-Host "已更新异地副本：$dest"
