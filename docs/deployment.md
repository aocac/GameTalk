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

### 数据迁移

- 服务端启动时自动执行 `migrations/*.sql`（幂等，`_migrations` 记录版本）。
- 手动执行：`docker compose exec server node dist/db/migrate-cli.js`

### 健康检查

- `GET /health` → `{"status":"ok",...}`；compose 中已配置 server/postgres 健康检查。

## 3. 构建与发布

```bash
# 服务端镜像
docker build -f docker/server.Dockerfile -t gametalk-server:latest .

# 客户端安装包（Windows）
cd client && npm run tauri build
# 产物：client/src-tauri/target/release/bundle/nsis/GameTalk_0.1.0_x64-setup.exe
```

## 4. 客户端连接服务器

- 默认 `http://127.0.0.1:8787`（本机自建服务器）。
- 连接远程服务器：设置 → 服务器地址改为 `https://你的域名`（WS/WSS 自动推导）。

## 5. GitHub Actions

- `.github/workflows/ci.yml`：server 测试构建、client 构建、Tauri cargo check、Docker 镜像构建（push/PR 触发）。

## 6. 权限需求（真实部署仍需用户提供）

1. Linux VPS 的 SSH 访问（或由用户执行 `deploy.sh`）
2. 域名与 DNS 控制权（Caddy 自动申请 Let's Encrypt 证书）
3. 若推送镜像到仓库：容器镜像仓库账号（也可直接在服务器上构建，无需仓库）

当前开发机无 Docker（2026-08-26 检查），镜像构建已在 CI 中配置，可在 GitHub Actions 中真实执行。
