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
| 2 | 最小实时通信闭环 | ✅ 完成 | 服务端网关+测试；客户端逻辑测试+联调 ✅ |
| 3 | 注册/登录/头像/昵称/用户ID | ✅ 完成 | argon2+JWT；WS 需 token；测试 14+3 ✅ |
| 4 | 房间/邀请码/成员/群聊/历史 | ✅ 完成 | rooms/messages 迁移；REST+WS 成员校验；游标分页；测试 23+3 ✅ |
| 5 | 游戏模式(快捷键/Overlay/声音/焦点) | ✅ 代码完成 | 三窗口架构；单测 7 ✅；⚠️ 快捷键/透明/焦点恢复需人类物理验收 |
| 6 | UI/设置/重连/错误/安全/客户端构建 | ✅ 完成 | CSP/NSIS/资料编辑；release 构建 ✅（exe 9MB/setup 2MB） |
| 7 | 服务端 Docker 化/生产部署准备 | ✅ 完成 | Dockerfile/compose/Caddyfile/deploy.sh/CI；⚠️ Docker 构建在 CI 执行 |
| 8 | 最终测试与验收 | ✅ 完成 | server 23 + client 10 全绿；浏览器 E2E ✅；冒烟 ✅ |

## 核心数据流（已落定）
```
客户端 main 窗口 ──REST(JWT Bearer)──> Fastify 路由(认证/房间/历史) ──SQL──> PostgreSQL
客户端 main 窗口 ──WS hello{token}──> 网关鉴权 → 绑定用户 ──room:join(校验成员)──> 订阅房间
消息: 客户端 message:send → 服务端 INSERT messages → 广播 message:new → 其他客户端
      → 更新聊天列表 + 播放提示音 + pushOverlayMessage → 消息 Overlay 显示 N 秒
游戏模式: 全局快捷键 → main 显示/定位/聚焦 input 窗口 → Enter: input emit → main sendMessage → hide
          → Windows 焦点还给先前前台窗口（游戏）
设置变更 → main applyOverlayConfig → overlay 窗口 setPosition/setSize + emit config → CSS zoom
```

## 待办与已知问题
- ⚠️ 需人类物理验收（本机为 Windows 桌面，建议直接跑安装包）：
  1. 游戏模式下全局快捷键在真实游戏中呼出输入框、不干扰游戏按键
  2. 消息 Overlay 绝对透明（无灰底）覆盖在游戏画面上
  3. Overlay 位置/缩放调整实时生效
  4. 发送后游戏焦点恢复
  5. 系统提示音
- Docker 实际构建/部署需 Linux 环境（CI 已配置，push 即跑）

## 验收记录（2026-08-26 本机实测）
- 自动化：server 23 测试 + client 10 测试全绿；typecheck/build/cargo check 全过
- 生产冒烟：NODE_ENV=production 启动 → migration 自动应用 → /health 200 → 注册/登录返回 JWT
- Windows 构建：gametalk.exe 9.0MB + GameTalk_0.1.0_x64-setup.exe（NSIS，2.0MB）
- 浏览器 E2E（真实 Chromium）：注册 browser_alpha → 创建房间"浏览器测试小队"(邀请码 UNGDCAM4) → 发消息 → 退出 → 注册 browser_beta → 邀请码加入 → 历史持久化可见 → 双向实时消息 ✅（截图 docs/e2e-chat-verification.png）
- 修复：React StrictMode 双挂载导致 ChatView 不重连（connect 幂等化 + cleanup 语义修正）

## 变更日志
- 2026-08-26：Phase 1 启动。环境盘点完成，决策 ADR-001~006。Git 初始化。
- 2026-08-26：Phase 1 完成。GitHub 仓库 https://github.com/aocac/GameTalk 创建并推送 main。
- 2026-08-26：Phase 2 服务端完成：WS 网关（hello/房间加入/消息广播/成员通知/校验），4 个集成测试通过（双客户端实时收发）。客户端 ChatSocket（自动重连+心跳）、chat store、WebAudio 提示音、快速聊天 UI 完成，前端构建通过；客户端逻辑测试进行中。
- 2026-08-26：Phase 3 完成：users 迁移、argon2、JWT 认证（register/login/me/patch）、WS token 认证、房间按 userId 多连接；客户端登录/注册 UI + 持久化 token。服务端 14 测试 + 客户端 3 集成测试全绿。
- 2026-08-26：Phase 4 完成：rooms/room_members/messages 迁移、邀请码、游标分页历史、WS 成员资格校验、消息持久化后广播；客户端多房间 UI（创建/加入/切换/离开/成员）。服务端 23 测试 + 客户端 3 集成测试全绿。
- 2026-08-26：Phase 5 完成（代码+单测）：三窗口架构（main/input/overlay）；全局快捷键 Ctrl+Shift+Space 呼出输入 Overlay；Enter 发送/Esc 取消；消息 Overlay 绝对透明+IgnoreCursorEvents+位置预设/缩放/自动时长（设置实时生效）；gameMode 管理器 7 个单测通过。⚠️ 待人类物理验收：快捷键游戏内呼出、透明渲染、焦点恢复、声音。
- ADR-007 记录：Tauri v2 的 WebviewWindow.getByLabel 返回 Promise；权限名是 core:window:allow-get-all-windows（无 allow-get-by-label）。
- 2026-08-26：Phase 6/7 完成：CSP 加固、NSIS 安装包（简体中文/英文）、资料编辑（昵称/头像 URL）、Dockerfile/compose/Caddyfile/deploy.sh/CI。Windows release 构建成功（9MB exe + 2MB setup）；服务端生产模式冒烟通过。
- 2026-08-26：Phase 8 完成：全量测试绿；浏览器真实 E2E（注册/建房/邀请码/历史/双向消息）通过；修复 StrictMode 双挂载断连 bug（坑位：React StrictMode 下 effect cleanup 会触发 disconnect，connect 需幂等且 cleanup 不应清空房间状态）。
- 关键坑位补充：④ PGlite 的 query 泛型无约束，Db 接口用 pg 的 QueryResultRow 约束需在实现里显式声明；⑤ React StrictMode 双挂载会执行 effect cleanup → 连接管理必须幂等。
- 关键坑位记录：① Node 22 undici WebSocket 的 addEventListener('message') 不触发，测试必须用 onmessage+派发队列；② @tauri-apps/plugin-global-hotkey 包不存在，正确名是 @tauri-apps/plugin-global-shortcut（crate 同名）；③ migrations 必须放包根目录（src/dist 双路径一致解析）；④ PGlite 的 query 泛型无约束，Db 接口用 pg 的 QueryResultRow 约束需在实现里显式声明。
