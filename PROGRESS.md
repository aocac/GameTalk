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
- **ADR-004 开发/测试用 PGlite**：本机无 PostgreSQL 与 Docker（2026-08-26 检查）。migration 为纯 SQL 文件，PGlite 与生产 PG 同源执行。PGlite 持久化目录 server/data/gametalk.pglite（本地开发数据不丢）。
- **ADR-005 实时消息：服务端内存房间表 + 广播**：单机轻量，不做 Redis 等外部依赖（第一版）。
- **ADR-006 密码哈希 argon2**：@node-rs/argon2（预编译二进制，无需 node-gyp）。
- **ADR-008 服务端形态：纯远程模式（2026-08-27 用户确认）**：客户端只连接**远程 Linux 服务器**（VPS + Docker + HTTPS/WSS），玩家零服务端负担。`dev/start-local.cmd` 仅作为开发验收辅助工具，不面向最终用户。待用户提供 VPS + 域名后执行 docker/deploy.sh 完成真实部署并作为客户端默认服务器。

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
| 9 | 功能增强 + 稳定性 + 三端 Release（Phase 9+） | ✅ 完成 | 删房/乐观发送/半开自愈/三端发布；物理验收 ✅；真实服务器部署 ✅ |

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
- ✅ 物理验收全部通过（2026-08-28 人类确认）：游戏内快捷键呼出、全局 ESC 不干扰游戏内 ESC、Overlay 绝对透明 + 位置/缩放、提示音、发送后焦点恢复、关闭三选项弹窗
- ✅ 真实服务器已部署上线（2026-08-28 用户确认；部署域名/IP 等信息不入公开仓库）
- 无未决阻塞项。后续候选（未排期）：REST 限流、消息分页向上翻页、水平扩展需引入 Redis（ADR-005 单机设计下不需要）

## 本地使用说明（开发/验收辅助）
- `dev/start-local.cmd`（仓库根）可一键启动本地服务端（数据持久化在 server/data/），**仅用于开发验收**，非产品形态。
- 产品形态（ADR-008）：客户端连接远程 Linux 服务器；部署见 docker/deploy.sh 与 docs/deployment.md。

## 验收记录（2026-08-26 本机实测）
- 自动化：server 25 测试 + client 11 测试全绿；typecheck/build/cargo check 全过
- 生产冒烟：NODE_ENV=production 启动 → migration 自动应用 → /health 200 → 注册/登录返回 JWT
- Windows 构建：gametalk.exe ~9MB + GameTalk_0.1.0_x64-setup.exe（NSIS，~2MB）
- 浏览器 E2E（真实 Chromium）：注册 browser_alpha → 创建房间"浏览器测试小队"(邀请码 UNGDCAM4) → 发消息 → 退出 → 注册 browser_beta → 邀请码加入 → 历史持久化可见 → 双向实时消息 ✅（docs/e2e-chat-verification.png）
- PGlite 持久化：注册 persist_user → 重启 server → 登录成功 ✅（server/data/gametalk.pglite）
- 连接失败提示：server 停止时登录显示「无法连接服务器（http://127.0.0.1:8787）…运行 dev/start-local.cmd」✅；server 启动后登录进入聊天界面且 WS「已连接」✅（docs/e2e-connected-after-server-up.png）
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
- 2026-08-26（用户物理反馈 4 项缺陷 + 修复）：
  - 关闭无选择 → hidden overlay/input 窗口使 app 不退出；加 Rust 托盘 + CloseRequested prevent_close + 前端三选项模态 + quit_app command（cargo feature `tray-icon` + Emitter trait）
  - 快捷键不能录制 → 新 HotkeyRecorder 组件捕获 keydown → 规范化为 Tauri 字符串 → reapplyHotkey 实时注册
  - Overlay 加载了主界面 → tauri.conf.json 中 input/overlay 窗口缺 `url`（加载了 index.html）→ 加 `url: "input.html"/"overlay.html"`
  - 头像手输 URL → `<input type=file>` + FileReader → POST /api/auth/avatar（服务端校验 dataUrl 格式/magic bytes/≤512KB，2 个新测试）
  - 浏览器 E2E 验证文件上传 → 截图 docs/e2e-avatar-settings.png；快捷键录制测试通过；新 NSIS 安装包（9MB exe / 2MB setup）已构建
- 2026-08-26（用户二轮反馈：连接中无提示 + 游戏内 ESC 关不掉）：
  - PGlite 持久化：config.pgliteDataDir（默认 data/gametalk.pglite），测试仍用内存库；验证重启后用户数据保留
  - dev/start-local.cmd：仓库根一键启动本地服务端（自动 npm install/build/启动），面向无 Node 运维背景用户
  - ChatSocket 连接超时（8s）+ lastError；chat store connectionError；聊天页 banner 明确提示 + 重试按钮
  - api.ts 网络错误 → ApiError('network_error', 中文提示)，登录页不再显示英文 'Failed to fetch'
  - 全局 ESC：输入框显示期间注册 'Esc' 全局快捷键（失焦也能关），隐藏后注销（不干扰游戏内 ESC）；单测覆盖
  - 浏览器验证：无 server 时登录显示明确中文提示 ✅；启动 server 后登录进入聊天 + WS 已连接 ✅
- 关键坑位记录：① Node 22 undici WebSocket 的 addEventListener('message') 不触发，测试必须用 onmessage+派发队列；② @tauri-apps/plugin-global-hotkey 包不存在，正确名是 @tauri-apps/plugin-global-shortcut（crate 同名）；③ migrations 必须放包根目录（src/dist 双路径一致解析）；④ PGlite 的 query 泛型无约束，Db 接口用 pg 的 QueryResultRow 约束需在实现里显式声明。

## 2026-08-27~28（Phase 9+：功能增强 + 稳定性 + 三端 Release）
- 2026-08-27：删除房间（WS room:delete，房主校验 only_owner、级联删、广播 room:deleted）；服务端 26 测试绿。
- 2026-08-27：修复「未订阅」——服务端 joinRoom 幂等化（重复 join 也回 room:joined，原 `conn.rooms.has` 早退吞响应）；客户端 2s 订阅看门狗自愈。
- 2026-08-27：乐观发送（自己消息即时上屏 pending 样式，message:new 按序校正去重）；历史加载占位；无房间时游戏内发送自动选首房+排队补发。
- 2026-08-27：半开连接自愈（心跳 15s + 35s 无 pong 强制重连；发送 5s 未确认强制重连；重连退避上限 5s）。
- 2026-08-27：重连后强制重载历史（selectRoom forceReload），补回断开期间消息；not_in_room 错误带 roomId 自动移除失效房间。
- 2026-08-27：三端 Release 流水线（Windows NSIS / Linux deb+AppImage / macOS dmg，GitHub runner 构建，v* 标签自动挂 Release）。坑：需 `permissions: contents: write`；产物 zip 嵌套目录需递归 glob；标签需 `git tag -f` 移到最新 main。
- 2026-08-28：代理设置项（useProxy/proxyAddress，set_proxy 命令经 WebView2 CDP Network.setProxyOverride，仅启用时生效）。
- 2026-08-28（重大根因）：Overlay/快捷键全失效 = 我加的主窗口 `additionalBrowserArgs: "--proxy-bypass-list=*"` 作用于共享 WebView2 浏览器进程，弄坏 overlay/input 窗口内容加载（overlay.tsx 从不挂载）。移除该参数后恢复。教训：additionalBrowserArgs 是全局副作用，慎用；此前误判的"半开连接"极可能也是它。
- 2026-08-28：Contributors 修复——历史提交原用假身份 GameTalk Dev，重写为 AppDuck <132205345+aocac@users.noreply.github.com>（filter-branch + force push）。
- 2026-08-28：清理临时诊断日志（diag_log/diag/odiag）；README 特性、PROGRESS 更新。
- 当前：服务端 29 测试 + 客户端 11 测试绿；三端 Release v0.1.1 资产已发布（win exe / linux deb+AppImage / macOS dmg）。
- 2026-08-28（接管：隐私审计 + 历史清除 + 安全加固 + 文档完善 + v0.1.1）：
  - 隐私审计：`.workbuddy/` 开发日志曾入库（已核实内容无密钥/真实域名），filter-branch 全历史清除 + `--prune-empty` + 强推 main 与 v0.1.0；全量跟踪文件扫描无密钥/真实 IP/可疑域名；docs 截图均为测试账号（browser_alpha 等）可保留。注意：GitHub 侧旧 commit 对象在 GC 前仍可按 SHA 直取，彻底擦除需联系 GitHub Support（低风险，内容无害）。
  - 服务端加固：WS 单连接限流（5s 滑动窗口 25 条 → `rate_limited`）、单帧 64KB 上限（超限 1009 断连）、协议层心跳巡检（30s ping / 70s 无 pong terminate，清理半开"幽灵成员"）、注册并发竞态由唯一索引兜底（23505 → 409）；gateway 连接清理统一收敛到 close 事件 + 修复格式粘连。
  - 客户端修复：api.ts 非 JSON 响应（反代 502 HTML 等）容错为 `ApiError('bad_response')`；排队发送单槽 → 队列化（`queuedSends`，订阅就绪后按序补发；error/重连/disconnect 均清空）；`rate_limited` 中文提示。
  - 部署：compose `CORS_ORIGIN` 可经 .env 覆盖（默认 `*`，桌面客户端不受浏览器同源限制）。
  - 文档：README（Releases 下载、MIT License 落地）、architecture（协议补 room:delete/rate_limited/心跳、目录树纠偏、可靠性参数更新）、testing（29+11、物理验收勾选、3MB 头像勘误、章节重编号）、deployment（CORS 变量、三端 Release、部署状态）、client/README 与 server/README 重写、新增 LICENSE。
  - 坑位补充：限流把 hello/ping 一并计数——写测试打满配额时要扣除 hello 占的 1 条。
  - 发布：v0.1.1（CI 4 job 绿 → tag 触发三端构建绿 → Release 4 资产挂载完成）。
- 2026-08-28（第二轮：双 Bug 修复 + 多房间 + 加固 + 工程化）：
  - 真机反馈 Bug：① 换快捷键后旧键仍生效——根因 registerHotkey 只注销新键，新增 `registeredHotkey` 追踪并注销旧键（含 stopGameMode 双保险）+ 有状态 mock 测试；② 中文输入法组词 Enter 误发送——composer 与游戏输入框 onKeyDown 增加 `isComposing || keyCode===229` 守卫。
  - 多房间订阅：客户端从"单房间订阅"改为订阅全部房间（服务端本就支持多房间），新增未读角标（unreadByRoom，选中清零）、Overlay 标注来源房间（pushOverlayMessage 带 roomName）、看门狗补订全部房间；成员事件不再按活跃房间过滤。**注意坑位**：message:new 的提示音/Overlay 现在对所有房间生效（这正是多房间订阅的意义）。
  - 历史向上翻页：loadOlderMessages（before 游标 + 去重合并），UI「加载更早的消息」按钮 + prepend 后滚动锚定（anchorRef 方案，翻页不触发自动滚底）。
  - REST 限流：@fastify/rate-limit（全局 300/分钟，注册/登录 10/分钟可配 RATE_LIMIT_*_MAX，测试模式自动放开），trustProxy 按反代头取真实 IP；坑位：errorResponseBuilder 返回值是 **throw** 的 error，必须带 `statusCode: 429` 才不会变 500。清空头像 '' 归一化为 null。
  - 头像带宽治理：新增 `GET /api/avatars/:id`（公开，UUID 不可枚举，5 分钟缓存），REST/WS 全链路把 data URL 转换为该端点绝对 URL（httpBase 取 Host + X-Forwarded-Proto）——3MB 头像不再随每条消息广播。语义：外链 URL 原样返回，无头像 null。
  - 运维：`npm run reset-password -- <用户名> <新密码>` CLI（服务器主人重置密码，PGlite 模式需先停服）。
  - 工程化：ESLint flat config 双工作区（client 含 react-hooks 规则），CI server/client job 加 lint 步骤；actions 全量升级（checkout v7 / setup-node v7 / upload-artifact v7 / download-artifact v8 / gh-release v3）消除 Node20 弃用警告；gateway 死代码 sendToUser 清理。
  - 坑位补充：vitest 的 vi.mock 工厂若引用已删除的模块级变量（registered.push），会在 mock 内部抛 ReferenceError 并被 SUT 的 try/catch 吞掉，表现为"快捷键静默注册不上"——mock 改动后必须同步清理工厂闭包。
  - 测试基线：server 30 + client 12 全绿；lint 双工作区绿。
  - 追加：copy-artifacts.mjs 修 bug——bundle 目录残留旧版本产物时"取第一个匹配"会把旧安装包复制成新版本（本地构建 0.2.0 时实锤：产物哈希 = 旧 0.1.0）；改为优先精确匹配当前版本号、否则取 mtime 最新。
  - 发布：v0.2.0（用户真机验收通过；CI 4 job 绿 → 三端构建绿 → Release 4 资产挂载完成）。版本号已全部同步 0.2.0。
  - 生产更新：真实服务器已滚动更新至 v0.2.0（2026-08-28，SSH 通道建立，部署细节见本地工作日志不入库）。坑位：VPS 克隆是贡献者历史重写前的旧链 → git pull 报 unrelated histories，需 reset --hard origin/main + 单独保留 VPS 本地自定义 compose（去 caddy/公网端口）；验证铁证 = 连打 12 次登录第 11 次起 429（限流为新代码行为）。遗留小项：/health 的 version 恒为 0.1.0（Docker 运行时无 npm_package_version），下次修为构建时烘焙。
