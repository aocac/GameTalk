# GameTalk

面向 PC 游戏玩家的轻量级桌面群组通信工具。

**核心体验**：按全局快捷键 → 呼出输入框 → 输入文字 → Enter 发送 → 自动关闭输入框 → 尽可能恢复游戏 → 房间成员实时收到消息 → 游戏内显示轻量 Overlay → 播放提示音。

## 产品形态

- **客户端**：Windows 桌面应用（Tauri 2），安装即用，玩家**无需**安装任何服务端或运行时。
- **服务端**：独立部署在 **Linux 服务器**（VPS/云主机，Docker 一键部署，自动 HTTPS/WSS）。
- 玩家在客户端「设置 - 服务器地址」填入服务器地址即可连接；好友间通过房间邀请码加入。

## 特性（第一版范围）

- 账号：注册、登录、头像、昵称、用户 ID
- 房间：创建房间、邀请码、加入房间、成员列表
- 群聊：实时消息、消息历史
- 游戏模式：全局快捷键、输入 Overlay、Enter 发送 / Esc 取消、消息 Overlay（**绝对透明背景** + 自定义位置/缩放）、提示音、自动恢复游戏焦点
- 基本设置：服务器地址、快捷键、Overlay 位置/缩放、声音开关

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
├── docker/          # 生产部署（Dockerfile / compose / Caddyfile / deploy.sh）
└── .github/workflows/ # CI
```

## 部署一台服务器（房主/社区）

```bash
# 在 Linux VPS 上（已装 Docker）：
git clone https://github.com/aocac/GameTalk
cd GameTalk/docker
bash deploy.sh            # 首次运行生成 .env，填入域名后再次运行即完成上线
```

完成后服务器地址即 `https://你的域名`，客户端填写该地址即可连接。
详见 [docs/deployment.md](docs/deployment.md)。

## 本地开发

```bash
# 服务端（开发：PGlite 文件持久化，默认 127.0.0.1:8787）
cd server && npm install && npm run dev
# 或 Windows 下双击仓库根目录 dev/start-local.cmd（开发辅助，非产品形态）

# 客户端（Tauri 桌面，需要 Rust + MSVC）
cd client && npm install && npm run tauri dev
```

详见 [docs/architecture.md](docs/architecture.md)。

## 文档

- [PROGRESS.md](PROGRESS.md) — 开发状态与决策记录（AI 外挂大脑）
- [AGENTS.md](AGENTS.md) — Agent 协作说明
- [docs/architecture.md](docs/architecture.md) — 架构文档
- [docs/deployment.md](docs/deployment.md) — 部署文档
- [docs/testing.md](docs/testing.md) — 测试与验收文档

## License

MIT（计划中）
