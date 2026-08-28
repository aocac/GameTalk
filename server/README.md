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

## 环境变量

复制 `.env.example` 为 `.env`，全部变量均有默认值；生产环境**必须**设置：

- `DATABASE_URL`：PostgreSQL 连接串（不设置则用 PGlite）
- `JWT_SECRET`：生产模式下禁止默认值，否则启动报错

## 结构

- `src/routes/`：REST（health / auth / rooms）
- `src/ws/gateway.ts`：WS 网关（JWT 鉴权、内存房间表广播、单连接限流、服务端心跳清理）
- `src/db/`：pg / PGlite 双实现 + migration 执行器
- `migrations/`：纯 SQL 迁移（生产 PG 与测试 PGlite 同源执行）

## 部署

见 [docker/](../docker/)（Dockerfile / docker-compose / Caddy / deploy.sh）与
[docs/deployment.md](../docs/deployment.md)。
