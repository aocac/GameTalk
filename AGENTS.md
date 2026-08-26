# AGENTS.md — Agent 协作说明

本文件是给（人类或 AI）开发协作者的操作手册。

## 工作循环（强制）

1. **先读 PROGRESS.md** — 每次开始新阶段前必须恢复上下文。
2. 分析 → 设计 → 实现 → 测试 → 修复 → commit → push → 继续。
3. 每个重要功能完成后必须跑：typecheck / lint / test / build（相关者）。
4. 完成 Phase、重大架构决策、复杂 Bug 修复后更新 PROGRESS.md。
5. 同一错误连续修 3 次失败 → **熔断**：停止盲目重试，整理错误日志 + 排查思路 + 需要的外部权限/环境，向用户汇报并等待指示。

## 代码与质量约定

- 客户端：`client/`，Tauri 2 + React + TS。Rust 侧保持最小（窗口/快捷键/Overlay 能力），逻辑尽量在 TS。
- 服务端：`server/`，Fastify + WS + pg。必须完全面向 Linux；Windows 只是开发环境。
- **客户端永不直连数据库**。
- 不使用 fake implementation / placeholder / mock 生产逻辑 / 硬编码 secret。env 变量一律走 `.env.example`。
- 数据库：所有 schema 变更 = 纯 SQL migration 文件（`server/migrations/*.sql`），`pg` 与 PGlite 同源执行。

## 测试策略

- 服务端：vitest 单测 + 集成测试（PGlite 内存库 + 真实 WS 客户端）。
- 客户端：核心逻辑（zustand store、ws client）vitest；UI 走人工验收。
- 端到端物理项（全局快捷键、Overlay 渲染、系统声音）：在无头环境跳过，PROGRESS.md 标记「需人类物理验收」。

## Git / GitHub 约定

- 每个 Phase 至少一个清晰 commit；分支命名 `feat/<phase>-<name>`。
- commit message 用常规格式：`feat(server): ...` / `fix(client): ...`。
- 远程仓库：GitHub `aocac/GameTalk`。阶段完成即 push，不等项目完成。

## 部署准备清单（Phase 7）

Dockerfile / docker-compose / 环境变量 / 数据库迁移 / 健康检查 / 部署文档 / GitHub Actions，缺一不可。
