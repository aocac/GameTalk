# GameTalk — PROGRESS.md（外挂大脑）

> 每次开始新阶段前必须先读此文件恢复上下文。每次完成 Phase / 重大架构决策 / 复杂 Bug 修复后必须更新。

## 项目目标（一句话）
面向 PC 游戏玩家的轻量级桌面群组通信工具：全局快捷键呼出 → 输入 → Enter 发送 → 自动关闭 → 恢复游戏 → 房间成员实时收到 → 游戏内绝对透明 Overlay 显示 + 提示音。

## 技术栈（已锁定）
| 层 | 选型 | 版本 | 理由 |
|---|---|---|---|
| 客户端 | Tauri 2 + React + TypeScript + Vite | Tauri 2.x / React 18 / TS 5 | 轻量(~10MB)、Windows 原生、透明置顶窗口能力 |
| 服务端 | Node.js + TypeScript + Fastify + @fastify/websocket | Node 22 / Fastify 5 | 轻量、WS 一等公民、AI 易维护 |
| 数据库 | PostgreSQL + 纯 SQL migration + `pg` | PG 16 | 稳定、免 ORM 心智负担 |
| 测试数据库 | PGlite（PostgreSQL WASM） | 0.2.x | 本机无 PG/Docker 时的真实 SQL 测试环境，与生产同源 migration |
| 认证 | JWT (HS256) + argon2 | — | 无状态、简单、可水平扩展 |
| 容器化 | Docker + docker-compose + Caddy(HTTPS/WSS) | — | Linux 部署 |
| 构建/CI | GitHub Actions | — | client: Windows build; server: docker build |

## 架构决策记录（ADR）
- **ADR-001 单仓库结构**：`client/`(Tauri) + `server/`(Fastify) 各自独立 package.json，不做 npm workspace，隔离干净、AI 易维护。
- **ADR-002 客户端不直连数据库**：一切数据经服务端 REST + WS。
- **ADR-003 Overlay 不做 D3D 挂钩/DLL 注入**：Tauri 全局透明置顶窗口（decorations:false, transparent:true, alwaysOnTop, skipTaskbar）+ ignore cursor events + 自定义位置/缩放。前提：用户游戏用无边框窗口化。
- **ADR-004 开发/测试用 PGlite**：本机无 PostgreSQL 与 Docker（2026-08-26 检查）。migration 为纯 SQL 文件，PGlite 与生产 PG 同源执行。
- **ADR-005 实时消息：服务端内存房间表 + 广播**：单机轻量，不做 Redis 等外部依赖（第一版）。
- **ADR-006 密码哈希 argon2（推荐 argon2 或 bcrypt 视 npm 编译情况）**：优先 argon2；若本机原生编译失败则降级 bcryptjs 纯 JS 并在 PROGRESS 记录。

## 环境事实（2026-08-26 检查）
- Windows 11 桌面（有真实显示器）✓ —— Overlay/快捷键/声音可做真实人工验收
- Node 22.22.2 (managed)、npm 10.9.7、Rust 1.98 MSVC、git 2.55 ✓
- MSVC Build Tools 2022 (cl/link)、Windows SDK 10.0.26100、WebView2 ✓ —— Tauri 可构建
- GitHub CLI 已登录 `aocac`（repo+workflow 权限）✓ —— 可创建仓库并 push
- Docker ❌ 未安装（Phase 7 需环境支持；先产出 Dockerfile/compose/CI，构建标记"需环境支持"）
- PostgreSQL ❌ 未安装（见 ADR-004）

## Phase 状态
| Phase | 内容 | 状态 | 备注 |
|---|---|---|---|
| 1 | 项目结构/Git/GitHub/环境/PROGRESS | ✅ 完成 | 仓库 https://github.com/aocac/GameTalk |
| 2 | 最小实时通信闭环 | 🔵 进行中 | 服务端网关+测试✅；客户端逻辑测试/联调中 |
| 3 | 注册/登录/头像/昵称/用户ID | ⚪ 未开始 | — |
| 4 | 房间/邀请码/成员/群聊/历史 | ⚪ 未开始 | — |
| 5 | 游戏模式(快捷键/Overlay/声音/焦点) | ⚪ 未开始 | 部分项需人类物理验收 |
| 6 | UI/设置/重连/错误/安全/客户端构建 | ⚪ 未开始 | — |
| 7 | 服务端 Docker 化/生产部署准备 | ⚪ 未开始 | Docker 构建需环境支持 |
| 8 | 最终测试与验收 | ⚪ 未开始 | — |

## 核心数据流（将在 Phase 2 落定后更新）
```
客户端 --REST(JWT)--> 服务端 --SQL--> PostgreSQL
客户端 <--WS(带token)--> 服务端(房间广播) --> 其他客户端(消息/Overlay/声音)
```

## 待办与已知问题
- （无）

## 变更日志
- 2026-08-26：Phase 1 启动。环境盘点完成，决策 ADR-001~006。Git 初始化。
- 2026-08-26：Phase 1 完成。GitHub 仓库 https://github.com/aocac/GameTalk 创建并推送 main。
- 2026-08-26：Phase 2 服务端完成：WS 网关（hello/房间加入/消息广播/成员通知/校验），4 个集成测试通过（双客户端实时收发）。客户端 ChatSocket（自动重连+心跳）、chat store、WebAudio 提示音、快速聊天 UI 完成，前端构建通过；客户端逻辑测试进行中。
- 关键坑位记录：① Node 22 undici WebSocket 的 addEventListener('message') 不触发，测试必须用 onmessage+派发队列；② @tauri-apps/plugin-global-hotkey 包不存在，正确名是 @tauri-apps/plugin-global-shortcut（crate 同名）；③ migrations 必须放包根目录（src/dist 双路径一致解析）。
