# GameTalk 部署文档

> 目标环境：Linux VPS / Cloud VM + Docker + PostgreSQL + Caddy（HTTPS/WSS 自动）。
> 开发/测试环境（无 Docker）可使用 PGlite 内存库直接跑 server。

## 1. 本地开发

```bash
# 服务端（开发，PGlite 内存库，零外部依赖）
cd server
npm install
npm run dev            # 监听 0.0.0.0:8787

# 测试（server + client 均为 vitest；client 集成测试会自动拉起真实 server）
cd server && npm test
cd client && npm test

# 客户端（Tauri 桌面，需要 Rust + MSVC）
cd client
npm install
npm run tauri dev      # 三个窗口：main / input / overlay
```

## 2. 生产部署（Docker Compose，一键脚本）

```bash
# 1. 上传 docker/ 目录到服务器（如 /opt/gametalk）
# 2. 首次运行（会生成 .env 并提示修改域名）
cd /opt/gametalk && bash deploy.sh

# 3. 修改域名后再次运行
nano .env && bash deploy.sh
```

### 服务构成

| 服务 | 说明 |
|---|---|
| `server` | GameTalk 服务端（Node 22 slim，非 root，健康检查，启动自动跑 migration） |
| `postgres` | PostgreSQL 16（数据卷持久化，healthcheck） |
| `caddy` | 反向代理 + 自动 HTTPS/WSS（`https://你的域名` 与 `wss://你的域名/ws`） |

### 环境变量（docker/.env.example）

| 变量 | 说明 |
|---|---|
| `JWT_SECRET` | JWT 签名密钥（必改，≥32 字符） |
| `POSTGRES_PASSWORD` | 数据库密码（必改） |
| `GAMETALK_HOST` | 域名，Caddy 据此申请证书 |
| `CORS_ORIGIN` | 可选，默认 `*`（桌面客户端不受浏览器同源限制）；需收紧时设置，多来源逗号分隔 |
| `TURN_SECRET` | 可选，自建 TURN 中继共享密钥（见第 9 节） |
| `TURN_URL` | 可选，TURN 地址（逗号分隔，建议同时给 UDP 与 TCP） |

### 数据迁移

- 服务端启动时自动执行 `migrations/*.sql`（幂等，`_migrations` 记录版本）。
- 手动执行：`docker compose exec server node dist/db/migrate-cli.js`

### 健康检查

- `GET /health` → `{"status":"ok",...}`；compose 中已配置 server/postgres 健康检查。

## 3. 构建与发布

```bash
# 服务端镜像
docker build -f docker/server.Dockerfile -t gametalk-server:latest .

# 客户端安装包（Windows，本机构建）
cd client && npm run build:full
# 产物：client/src-tauri/target/release/bundle/nsis/GameTalk_<版本>_x64-setup.exe
# 并自动复制到仓库根目录：GameTalk-<版本>-x64-Setup.exe
```

**三端 Release（推荐）**：推送 `v*` 标签（如 `v0.1.1`）触发 `.github/workflows/build-desktop.yml`，
由 GitHub Actions 构建 Windows NSIS / Linux deb+AppImage / macOS dmg，并自动挂到对应 GitHub Release。

## 4. 客户端连接服务器

- 默认 `http://127.0.0.1:8787`（本机自建服务器）。
- 连接远程服务器：设置 → 服务器地址改为 `https://你的域名`（WS/WSS 自动推导）。

## 5. GitHub Actions

- `.github/workflows/ci.yml`（push/PR 触发）：server 测试构建、client 构建、Tauri cargo check、Docker 镜像构建。
- `.github/workflows/build-desktop.yml`（`v*` 标签触发）：三端桌面构建并挂载 GitHub Release。

## 6. 数据库备份与恢复

> 用户数据只存在于 VPS 单盘卷（`docker_pgdata`）——这是部署中最大的单点风险。
> 仓库内置「服务器每日备份 + Windows 管理机异地副本」方案；`deploy.sh` 第 4 步会自动安装备份调度。

### 自动备份（服务器端）

- 脚本：`docker/backup-db.sh` —— `pg_dump -Fc` 全量转储 + `docker-compose.yml`/`.env` 配置快照 + `pg_restore -l` 完整性校验（失败自动丢弃坏 dump）+ 14 天轮转 + flock 防重叠。
- 调度：systemd timer 每日 04:30（服务器时区）执行，`Persistent=true` 错过自动补跑。
- 产物：`<仓库根>/backups/gametalk-db-YYYYMMDD-HHMMSS.dump` 与 `configs-*.tar.gz`；备份目录 root-only。configs 含密钥（600），仅作服务器本地副本——JWT/DB 密码丢失可重建，代价只是重新登录。
- 手动触发 / 查看排期：

```bash
sudo bash /root/gametalk/docker/backup-db.sh     # 立即备份一次
systemctl list-timers | grep gametalk            # 确认 timer 已排期
tail /root/gametalk/backups/backup.log           # 备份日志
```

### 异地副本（Windows 管理机）

- 脚本：`docker/pull-backups-windows.ps1` —— 经 `ssh + sudo cat` 把 VPS 上最新的数据库 dump 流式下载到 `%USERPROFILE%\GameTalkBackups`，SHA256 校验传输完整性，本地保留 90 天（备份目录保持 root-only 最小权限，普通账户不可 scp 直读）。依赖 `~/.ssh/config` 的 `gametalk-vps` 主机别名。
- 注册 Windows 任务计划程序每日执行（示例）：

```powershell
schtasks /Create /F /TN "GameTalk 备份异地拉取" /SC DAILY /ST 09:10 `
  /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File C:\path\to\GameTalk\docker\pull-backups-windows.ps1"
```

- 建议每月做一次恢复演练（下述步骤在 VPS 上用最新 dump 验证行数即可，不必真删数据）。

### 恢复步骤

```bash
cd /root/gametalk/docker
docker compose stop server                       # 1) 停止写入端
# 2) 从备份恢复（--clean 覆盖现有对象；postgres 容器名用 docker ps 确认）：
docker exec -i docker-postgres-1 pg_restore -U gametalk -d gametalk --clean --if-exists \
  < ../backups/gametalk-db-YYYYMMDD-HHMMSS.dump
docker compose start server                      # 3) 重启并验证 /health、登录、历史消息
```

> 可选升级：条件允许时将备份再推送一份到对象存储（S3/COS/OSS 免费额度即可），
> 把异地副本从「管理机定时拉取」升级为「服务器定时推送」，进一步降低对单台管理机的依赖。

## 7. 客户端下载

- 稳定版：[GitHub Releases](https://github.com/aocac/GameTalk/releases/latest)（Windows / Linux / macOS 安装包）。

## 8. 部署状态

该部署方案已在真实服务器上长期稳定运行（2026-08-28 起）。自建部署按第 2 节流程操作即可，
数据库备份与恢复见第 6 节。

## 9. TURN 中继（跨网络屏幕共享，可选）

屏幕共享的媒体流在成员之间 P2P 直连，服务器只转发信令、不消耗带宽。但跨网络时部分网络环境
（典型：对称 NAT、运营商封 UDP）直连打不通，需要一台 TURN 中继兜底。GameTalk 的约定：

- 客户端优先 P2P 直连；只有直连失败才走 TURN，中继带宽按用户、限时使用。
- TURN 密钥（`TURN_SECRET`）**只存服务端**，由 `GET /api/turn` 为登录用户签发 1 小时限时凭据
  （coturn `use-auth-secret` REST 约定），客户端不含密钥——不会被滥用来跑别的流量。

### 部署 coturn（Docker，与 GameTalk 同机即可）

```bash
# 1) 生成密钥并写入 compose 环境变量
TURN_SECRET=$(openssl rand -hex 16)
# 追加到 docker/.env：
#   TURN_SECRET=<上面的值>
#   TURN_URL=turn:服务器公网IP:3478,turn:服务器公网IP:3478?transport=tcp
# 并在 compose 的 server 服务 environment 中加两行：TURN_SECRET: ${TURN_SECRET} / TURN_URL: ${TURN_URL}

# 2) 写 coturn 配置（注意 external-ip 用「公网IP/内网IP」，云服务器多为 1:1 NAT）
cat > /opt/gametalk/turnserver.conf <<EOF
listening-port=3478
realm=gametalk
use-auth-secret
static-auth-secret=$TURN_SECRET
external-ip=服务器公网IP/服务器内网IP
min-port=49160
max-port=49200
fingerprint
no-tls
no-dtls
verbose
EOF

# 3) 运行（host 网络简化端口管理）
docker run -d --name coturn --network host --restart unless-stopped \
  -v /opt/gametalk/turnserver.conf:/etc/coturn/turnserver.conf:ro coturn/coturn:latest \
  -c /etc/coturn/turnserver.conf

# 4) 重建 GameTalk server 使其读到新环境变量
cd docker && docker compose up -d --build server
```

### 检查清单

- 防火墙 / 云安全组放行：**3478 UDP+TCP**、**49160-49200 TCP**（中继端口段）。云厂商安全组常默认只放 TCP，UDP 被拦时 TCP 中继仍可工作（实测路径）。
- 验证：`docker logs coturn` 应有 `TCP listener opened`；客户端点「观看」若直连失败会自动走中继出画面。
- 已知坑：配置文件若为 root 600，容器内非 root 的 turnserver 进程读不了（表现为整份配置未生效），`chmod 644` 即可。

