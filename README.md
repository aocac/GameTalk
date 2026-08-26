# GameTalk

面向 PC 游戏玩家的轻量级桌面群组通信工具。

**核心体验**：按全局快捷键 → 呼出输入框 → 输入文字 → Enter 发送 → 自动关闭输入框 → 尽可能恢复游戏 → 房间成员实时收到消息 → 游戏内显示轻量 Overlay → 播放提示音。

## 特性（第一版范围）

- 账号：注册、登录、头像、昵称、用户 ID
- 房间：创建房间、邀请码、加入房间、成员列表
- 群聊：实时消息、消息历史
- 游戏模式：全局快捷键、输入 Overlay、Enter 发送 / Esc 取消、消息 Overlay（**绝对透明背景** + 自定义位置/缩放）、提示音、自动恢复游戏焦点
- 基本设置：快捷键、Overlay 位置/缩放、声音开关

## 技术栈

| 层 | 技术 |
|---|---|
| 客户端 | Tauri 2 + React + TypeScript（Windows） |
| 服务端 | Node.js + TypeScript + Fastify + WebSocket（Linux） |
| 数据库 | PostgreSQL（生产）/ PGlite（开发测试） |
| 部署 | Docker + docker-compose + Caddy + HTTPS/WSS |

## 仓库结构

```
gametalk/
├── client/          # Tauri 2 桌面客户端（React + TS）
├── server/          # Fastify API + WebSocket 服务端（Node + TS）
├── docs/            # 架构 / 部署 / 测试文档
├── docker/          # 部署相关文件
└── .github/workflows/ # CI
```

## 快速开始（开发）

```bash
# 服务端（默认 127.0.0.1:8787，开发模式使用 PGlite 内存库，零依赖启动）
cd server
npm install
npm run dev

# 客户端（Tauri 桌面，需要 Rust + MSVC）
cd client
npm install
npm run tauri dev
```

详见 [docs/architecture.md](docs/architecture.md) 与 [docs/deployment.md](docs/deployment.md)。

## 文档

- [PROGRESS.md](PROGRESS.md) — 开发状态与决策记录（AI 外挂大脑）
- [AGENTS.md](AGENTS.md) — Agent 协作说明
- [docs/architecture.md](docs/architecture.md) — 架构文档
- [docs/deployment.md](docs/deployment.md) — 部署文档
- [docs/testing.md](docs/testing.md) — 测试与验收文档

## License

MIT（计划中）
