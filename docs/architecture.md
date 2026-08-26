# GameTalk 架构文档

## 1. 总览

```
┌─────────────────────────────┐       REST + WebSocket(JWT)       ┌──────────────────────────────┐
│  GameTalk 客户端 (Windows)   │ ────────────────────────────────► │  GameTalk Server (Linux)      │
│  Tauri 2 + React + TS        │                                   │  Fastify + WS + Node 22      │
│  ├─ 主窗口（聊天 UI）        │ ◄──────────────────────────────── │  ├─ REST 路由（认证/房间）    │
│  ├─ 输入 Overlay（游戏内）   │           广播消息                │  ├─ WS 网关（房间 pub/sub）  │
│  └─ 消息 Overlay（绝对透明） │                                   │  └─ 内存房间表                │
└─────────────────────────────┘                                   └──────────────┬───────────────┘
                                                                                  │ SQL (pg)
                                                                          ┌───────▼────────┐
                                                                          │ PostgreSQL 16   │
                                                                          └────────────────┘
```

**核心原则**：客户端永不直连数据库；一切数据经服务端 REST + WebSocket。

## 2. 技术选型与理由

| 层 | 选型 | 理由 |
|---|---|---|
| 客户端 | Tauri 2 + React 18 + TS + Vite | 安装包 ~10MB；系统级全局快捷键、透明置顶窗口原生支持；Rust 侧极小 |
| 服务端 | Node 22 + Fastify 5 + @fastify/websocket | 轻量、WebSocket 一等公民、TS 全栈类型统一 |
| 数据库 | PostgreSQL 16 | 稳定；`pg` 直连 + 纯 SQL migration，无 ORM 心智负担 |
| 开发/测试库 | PGlite (WASM PostgreSQL) | 本机无 PG/Docker 时的真实 SQL 环境；与生产同源 migration |
| 认证 | JWT (HS256, jose) + argon2 | 无状态、可水平扩展；密码哈希行业标准 |
| 部署 | Docker + docker-compose + Caddy | Linux 一键部署；Caddy 自动 HTTPS/WSS |

## 3. 目录结构

```
gametalk/
├── client/                  # Tauri 2 桌面客户端
│   ├── src/                 # React 前端
│   │   ├── app/             # 基础能力：types / ws / audio / settings
│   │   ├── stores/          # zustand 状态（auth / chat / settings）
│   │   ├── views/           # 页面视图
│   │   └── components/      # UI 组件
│   └── src-tauri/           # Rust 壳（窗口 / 全局快捷键 / 单实例）
├── server/                  # Fastify 服务端
│   ├── src/
│   │   ├── routes/          # REST 路由（health / auth / rooms）
│   │   ├── ws/              # WebSocket 网关（认证 + 房间广播）
│   │   ├── db/              # pg/PGlite 抽象 + migration 执行器
│   │   └── lib/             # jwt / password / envfile
│   ├── migrations/          # 纯 SQL migration（生产与 PGlite 同源）
│   └── test/                # vitest 单测 + 集成测试
├── docker/                  # 生产部署 compose 与配置
└── docs/                    # 本文档 / 部署 / 测试
```

## 4. 实时通信协议（WS）

**连接**：`/ws`，客户端连接成功后发送 `hello`（Phase 3 起携带 JWT token 替代匿名昵称）。

**客户端 → 服务端**
```json
{"type":"hello","payload":{"name":"Alice"}}
{"type":"room:join","payload":{"roomId":"lobby"}}
{"type":"room:leave","payload":{"roomId":"lobby"}}
{"type":"message:send","payload":{"roomId":"lobby","text":"hi"}}
{"type":"ping"}
```

**服务端 → 客户端**
```json
{"type":"hello:ok","payload":{"me":{"id":"...","username":"Alice"}}}
{"type":"room:joined","payload":{"roomId":"lobby","members":[...]}}
{"type":"member:joined","payload":{"roomId":"lobby","member":{...}}}
{"type":"member:left","payload":{"roomId":"lobby","userId":"...","username":"..."}}
{"type":"message:new","payload":{"roomId":"lobby","message":{...}}}
{"type":"error","payload":{"code":"...","message":"..."}}
{"type":"pong"}
```

**房间模型（第一版）**：服务端内存 `roomId -> 成员表`，广播即遍历。单机轻量；不做 Redis 等外部依赖（ADR-005）。Phase 4 起消息持久化，房间元数据入 PostgreSQL。

## 5. 数据库 Schema（migration 演进）

- `migrations/*.sql` 按文件名顺序执行，`_migrations` 表记录已应用版本。
- Phase 3: `users`（注册/登录）
- Phase 4: `rooms` / `room_members` / `messages`（房间、成员、历史）

## 6. 游戏 Overlay（ADR-003 妥协方案）

不做 Direct3D/OpenGL 挂钩、不做 DLL 注入。使用 Tauri 原生能力：

- **输入 Overlay**：独立 WebviewWindow（`decorations:false, transparent:true, alwaysOnTop:true, skipTaskbar:true`），全局快捷键呼出，Enter 发送 / Esc 取消，关闭后恢复游戏焦点。
- **消息 Overlay**：同参数 + `set_ignore_cursor_events(true)`（点击穿透），绝对透明背景（CSS `background: transparent`），位置/缩放由设置驱动。
- **前提**：目标用户在游戏中采用**无边框窗口化**模式（覆盖式窗口在独占全屏下无效）。

## 7. 断线重连与可靠性

- WS 客户端：指数退避重连（1s → 2s → … ≤15s），30s 心跳 ping。
- 服务端优雅关闭：SIGINT/SIGTERM 收尾（关 WS、关连接池）。
- 生产健康检查：`GET /health`（含 DB 探活），供容器编排使用。

## 8. 安全

- 密码 argon2 哈希；JWT HS256，`JWT_SECRET` 生产必配。
- 输入长度/内容校验（消息 ≤2000 字符等）；WS 消息类型白名单。
- CORS 来源可配置；生产建议设置明确来源。
- 无硬编码 secret；`.env.example` 提供模板。
