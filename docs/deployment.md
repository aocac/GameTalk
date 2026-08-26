# GameTalk 部署文档

> 目标环境：Linux VPS / Cloud VM + Docker + PostgreSQL + Reverse Proxy (Caddy) + HTTPS/WSS。
> 开发/测试环境（无 Docker 时）可使用 PGlite 内存库直接跑 server。

## 1. 本地开发

```bash
# 服务端（开发，PGlite 内存库，零外部依赖）
cd server
npm install
npm run dev            # 监听 0.0.0.0:8787

# 测试
npm test               # vitest（PGlite + 真实 WS 客户端）

# 客户端
cd client
npm install
npm run tauri dev      # 需要 Rust + MSVC（Windows）
```

## 2. 生产部署（Docker Compose）

### 2.1 前置

- 一台 Linux 服务器（建议 1C2G 起），安装 Docker + Compose 插件
- 域名解析到服务器（如 `chat.example.com`），开放 80/443
- 服务器上创建目录：`/opt/gametalk`，放入 `docker-compose.yml` 与 `.env`

### 2.2 环境变量（`.env`）

```bash
# 必填：生产必须替换
JWT_SECRET=<长随机串，至少 32 字符>
POSTGRES_PASSWORD=<数据库密码>

# 可选
GAMETALK_HOST=chat.example.com   # Caddy 域名
SERVER_PORT=8787
```

### 2.3 服务构成

| 服务 | 镜像/来源 | 说明 |
|---|---|---|
| `server` | 本地构建 `gametalk-server` | Node 22 多阶段构建，启动时自动跑 migration |
| `postgres` | postgres:16-alpine | 数据卷持久化 |
| `caddy` | caddy:2-alpine | 反向代理 + 自动 HTTPS，`/ws` 走 WSS |

### 2.4 健康检查

- `GET /health` → `{"status":"ok",...}`；server 容器配置 `healthcheck`（wget 探活）。

### 2.5 数据库迁移

- 服务端启动时自动执行 `migrations/*.sql`（幂等，`_migrations` 记录版本）。
- 也可手动执行：`docker compose exec server node dist/db/migrate-cli.js`

## 3. 构建与发布

```bash
# 服务端镜像
docker build -t gametalk-server:latest -f docker/server.Dockerfile .

# 客户端安装包（Windows）
cd client && npm run tauri build   # 产物在 src-tauri/target/release/bundle/
```

## 4. GitHub Actions（CI）

- `ci-server.yml`：server 安装 → typecheck → test → build。
- `ci-client.yml`：client tsc/vite build。
- （Phase 7 完善）`cd.yml`：打镜像并推送容器仓库。

## 5. 权限与账号需求清单

完成**真实部署**还需要用户提供：
1. Linux VPS / Cloud VM 的 SSH 访问（或由用户执行部署脚本）
2. 域名与 DNS 控制权（Caddy 自动申请证书）
3. 容器镜像仓库账号（如需推送镜像；也可在服务器上直接构建）

如以上齐备，可继续执行 `deploy.sh` 完成端到端上线。
