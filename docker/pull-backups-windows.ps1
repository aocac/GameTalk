# GameTalk 异地备份拉取（在 Windows 管理机上运行；配合 VPS 上的 gametalk-backup.timer）
# 依赖：~/.ssh/config 中配置了 gametalk-vps 主机别名（私钥只存本机）
# 通道：ssh + sudo cat 流式下载（备份目录 root-only，普通账户不可 scp 直读），SHA256 校验完整性
# 手动执行：powershell -ExecutionPolicy Bypass -File docker\pull-backups-windows.ps1
# 调度方式见 docs/deployment.md「数据库备份与恢复」
$ErrorActionPreference = "Stop"

$sshOpts = "-o BatchMode=yes -o ConnectTimeout=15"
$dest = Join-Path $env:USERPROFILE "GameTalkBackups"
New-Item -ItemType Directory -Force -Path $dest | Out-Null

$latestDump = (ssh $sshOpts.Split(' ') gametalk-vps "sudo sh -c 'ls -1t /root/gametalk/backups/gametalk-db-*.dump 2>/dev/null | head -n1'")
if ([string]::IsNullOrWhiteSpace($latestDump)) {
    throw "VPS 上没有数据库备份：检查服务器 gametalk-backup.timer 是否已启用"
}
$latestDump = $latestDump.Trim()
$name = $latestDump.Substring($latestDump.LastIndexOf("/") + 1)
$out = Join-Path $dest $name

Write-Host "拉取 $latestDump ..."
# 二进制必须经 cmd 重定向落盘：PowerShell 管道会按文本重编码，会损坏 dump
cmd /c "ssh $sshOpts gametalk-vps sudo cat $latestDump > $out"

$size = (Get-Item $out).Length
if ($size -lt 1KB) { throw "拉取的 dump 异常（仅 $size 字节）：$out" }

$remoteHash = ((ssh $sshOpts.Split(' ') gametalk-vps "sudo sha256sum $latestDump") -split '\s+')[0].ToLower()
$localHash = (Get-FileHash -Algorithm SHA256 $out).Hash.ToLower()
if ($remoteHash -ne $localHash) { throw "SHA256 不一致（远端 $remoteHash / 本地 $localHash），已保留文件供排查：$out" }

# 本地保留 90 天
Get-ChildItem $dest -File |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-90) } |
    Remove-Item -Force

Write-Host "已更新异地副本：$out（$size 字节，SHA256 校验一致）"
