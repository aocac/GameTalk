# GameTalk 架构文档

## 1. 总览

```
┌─────────────────────────────┐       REST + WebSocket(JWT)       ┌──────────────────────────────┐
│  GameTalk 客户端 (Windows)   │ ────────────────────────────────► │  GameTalk Server (Linux VPS)  │
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

**产品形态**：客户端是纯终端（连远程 Linux 服务器），玩家安装即用、零服务端负担；服务端由房主/社区独立部署（Linux VPS + Docker + HTTPS/WSS）。

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
│   │   ├── app/             # 基础能力：types / ws / api / settings / gameMode / audio
│   │   ├── stores/          # zustand 状态（auth / chat）
│   │   ├── App.tsx          # 主窗口 UI（登录 / 聊天 / 设置 / 关闭确认）
│   │   ├── input.tsx        # 输入 Overlay 窗口入口
│   │   └── overlay.tsx      # 消息 Overlay 窗口入口
│   └── src-tauri/           # Rust 壳（托盘 / 单实例 / quit_app / set_proxy）
├── server/                  # Fastify 服务端
│   ├── src/
│   │   ├── routes/          # REST 路由（health / auth / rooms）
│   │   ├── ws/              # WS 网关（认证 + 房间广播 + 限流 + 心跳清理）
│   │   ├── db/              # pg/PGlite 抽象 + migration 执行器
│   │   └── lib/             # jwt / password / image / invite / envfile
│   ├── migrations/          # 纯 SQL migration（生产与 PGlite 同源）
│   └── test/                # vitest 单测 + 集成测试
├── docker/                  # 生产部署 compose 与配置
└── docs/                    # 本文档 / 部署 / 测试
```

## 4. 实时通信协议（WS）

**连接**：`/ws`，客户端连接成功后发送 `hello` 携带 JWT token，服务端校验并绑定用户。

**客户端 → 服务端**
```json
{"type":"hello","payload":{"token":"<JWT>"}}
{"type":"room:join","payload":{"roomId":"..."}}
{"type":"room:leave","payload":{"roomId":"..."}}
{"type":"room:delete","payload":{"roomId":"..."}}
{"type":"member:kick","payload":{"roomId":"...","userId":"..."}}
{"type":"message:send","payload":{"roomId":"...","text":"hi"}}
{"type":"ping"}
```

**服务端 → 客户端**
```json
{"type":"hello:ok","payload":{"me":{"id":"...","username":"Alice","avatarUrl":"https://.../api/avatars/..."}}}
{"type":"room:joined","payload":{"roomId":"...","members":[...]}}
{"type":"member:joined","payload":{"roomId":"...","member":{...}}}
{"type":"member:left","payload":{"roomId":"...","userId":"...","username":"..."}}
{"type":"member:kicked","payload":{"roomId":"...","userId":"...","username":"..."}}
{"type":"message:new","payload":{"roomId":"...","message":{...}}}
{"type":"room:deleted","payload":{"roomId":"..."}}
{"type":"error","payload":{"code":"...","message":"...","roomId":"..."}}
{"type":"pong"}
```

**房间模型**：服务端内存 `roomId -> userId -> {sockets}`（同一用户可多端连接）。消息先持久化再广播；`joinRoom` 幂等（重复 join 也回 `room:joined`，客户端有 2s 订阅看门狗自愈）；`room:delete` 仅房主可调用，级联删除并广播 `room:deleted`；`member:kick` 仅房主可调用，把成员移出房间（DB 删除 + 全员通知 `member:kicked` + 被踢者订阅清理），被踢者客户端自动移除房间并切换。**客户端订阅其全部房间**（非活跃房间也能实时收消息，UI 显示未读角标，Overlay 标注来源房间）。

**头像分发**：`users.avatar_url` 存 data URL，但所有对外接口（REST 响应 / WS 广播 / 成员表）一律转换
为 `GET /api/avatars/<userId>` 绝对 URL（按请求头推导 base，反代后走 X-Forwarded-Proto），
避免 base64 随每条消息广播与成员表内嵌。

**WS 加固与保活**：
- 单连接限流：5s 滑动窗口最多 25 条消息，超出回 `error(code=rate_limited)`。
- 单帧上限 64KB（`maxPayload`），超限直接断连（close code 1009）。
- 服务端每 30s 发协议层 ping；70s 无 pong 的死连接被 terminate 并清理房间订阅（防"幽灵成员"）。

## 5. 数据库 Schema（migration 演进）

- `migrations/*.sql` 按文件名顺序执行，`_migrations` 表记录已应用版本。
- Phase 3: `users`（注册/登录）
- Phase 4: `rooms` / `room_members` / `messages`（房间、成员、历史）

## 6. 游戏 Overlay（透明置顶窗口方案）

不做 Direct3D/OpenGL 挂钩、不做 DLL 注入。使用 Tauri 原生能力，三窗口架构（Vite 多页入口：index/input/overlay）：

- **main**：聊天主窗口（React 全量 UI）
- **input**（输入 Overlay）：`decorations:false, transparent:true, alwaysOnTop:true, skipTaskbar:true, focus:true`；全局快捷键（默认 `Ctrl+Shift+Space`，设置可改）呼出 → 定位主屏底部居中 → 聚焦；Enter 发送（emit `game-input-send` → 主窗口走 WS）→ 自动隐藏；Esc 取消（emit `game-input-cancel`）。
- **overlay**（消息 Overlay）：同参数 + `focus:false` + `setIgnoreCursorEvents(true)`（点击穿透）；背景**绝对透明**（CSS `background: transparent`）；位置 6 预设（左上/上中/右上/左下/下中/右下）+ 缩放 0.5–2.0 + 自动隐藏时长 2–15s，设置实时生效（`applyOverlayConfig` → setPosition/setSize + emit config → CSS zoom）。

**焦点恢复**：输入窗发送后隐藏，Windows 将焦点还给先前的前台窗口（即游戏）。**前提**：目标用户在游戏中采用**无边框窗口化**模式（覆盖式窗口在独占全屏下无效）。

## 7. 断线重连与可靠性

**客户端**（ChatSocket + chat store）：
- 快速退避重连：1s → 1s → 2s → 3s → 5s（封顶 5s），另有 8s 握手超时。
- 应用层心跳：15s 一次 ping；35s 无 pong 判定半开连接，强制重连。
- 发送自愈：消息发出 5s 未被确认（有未决乐观消息）判定连接假活，强制重连。
- 订阅看门狗：连接已开但活跃房间未订阅时，每 2s 补发 `room:join`。
- 重连成功后强制重载活跃房间历史，补回断开期间已入库的消息。

**服务端**：
- SIGINT/SIGTERM 优雅关闭（关 WS、关连接池）；协议层心跳巡检（见第 4 节）。
- 生产健康检查：`GET /health`（含 DB 探活），供容器编排使用。

## 8. 安全

- 密码 argon2 哈希；JWT HS256，`JWT_SECRET` 生产必配（默认值启动即报错）。
- 输入长度/内容校验（消息 ≤2000 字符、房间 id ≤64、用户名 3-24 位白名单）；WS 消息类型白名单。
- 限流：REST 全局每 IP 每分钟 300 次（`RATE_LIMIT_MAX`），注册/登录加严到每分钟 10 次
  （`RATE_LIMIT_AUTH_MAX`，防爆破），WS 单连接每 5s 25 条；超限统一回 `rate_limited`/HTTP 429。
  反代后按 X-Forwarded-For 取真实 IP（`trustProxy`，8787 端口仅绑 127.0.0.1）。
- WS 加固：单帧 64KB 上限（见第 4 节）。
- 头像：上传 data URL 类型/大小（≤3MB）/魔数三重校验；分发走 `/api/avatars/:id`（公开端点，
  id 为不可枚举 UUID），带 5 分钟缓存头。
- 注册并发竞态由用户名唯一索引兜底（冲突返回 409）。
- CORS 可配置：compose 默认 `*`（桌面客户端不受浏览器同源限制），可经 `CORS_ORIGIN` 收紧。
- 无硬编码 secret；`.env.example` 提供模板；忘记密码由服务器主人用 `npm run reset-password` 重置。
