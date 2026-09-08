# GameTalk Server

Fastify + WebSocket + PostgreSQL 服务端，面向 Linux 部署（Windows 仅作开发环境）。

## 常用命令

```bash
npm install
npm run dev          # 开发模式（tsx watch，PGlite 文件持久化到 data/）
npm test             # vitest（PGlite 内存库 + 真实 WS 客户端）
npm run lint         # ESLint
npm run typecheck    # tsc --noEmit
npm run build        # tsc → dist/
npm start            # 生产模式（node dist/index.js，需 DATABASE_URL + JWT_SECRET）
npm run migrate      # 手动执行 migrations/*.sql（服务启动时也会自动执行）
npm run reset-password -- <用户名> <新密码>   # 服务器主人重置用户密码（PGlite 模式需先停服）
```

测试基线 89 例 / 11 个文件，包含 REST、WS 网关、好友、私聊、表情、邀请、转发、屏幕共享信令、TURN 凭据，以及 `test/regressions.test.ts`（分页、越权、竞态、输入校验等回归用例）。

## 环境变量

复制 `.env.example` 为 `.env`，所有变量都有默认值；生产环境**必须**设置：

- `DATABASE_URL`：PostgreSQL 连接串（不设置则用 PGlite）
- `JWT_SECRET`：生产模式下禁止默认值，否则启动报错

可选：`RATE_LIMIT_MAX` / `RATE_LIMIT_AUTH_MAX`（限流阈值）、`TURN_SECRET` / `TURN_URL`（屏幕共享中继）、`CORS_ORIGIN`、`LOG_LEVEL`、`PGLITE_DATA_DIR`。完整清单见 `.env.example`。

## 结构

- `src/routes/`：REST（health / auth / rooms / invites / friends / dm / stickers / media / turn）
- `src/ws/gateway.ts`：WS 网关（JWT 鉴权、内存房间表广播、花名册与在线状态、屏幕共享信令透传、单连接限流、心跳清理）
- `src/lib/`：jwt / password / image / invite / avatar / validate / envfile
- `src/db/`：pg 与 PGlite 双实现 + migration 执行器（同一接口，生产与测试同源 SQL）
- `migrations/`：纯 SQL 迁移，启动时按文件名顺序自动应用，`_migrations` 表记录版本

## 约定

- 新增迁移文件后立即单独 `git add`（历史上漏提交过三次，缺迁移不会让 CI 失败，只会静默少跑用例）。
- 所有直接进 SQL 的 UUID 先用 `lib/validate.isUuid` 校验；非字符串文本入参统一归零。
- 新增环境变量要同步写进 `.env.example`。
- 广播、历史接口、客户端转换三处的展示字段必须同时改（漏一处就会出现「刷新后字段消失」）。

## 部署

见 [docker/](../docker/)（Dockerfile / docker-compose / Caddy / deploy.sh）与
[docs/deployment.md](../docs/deployment.md)。
