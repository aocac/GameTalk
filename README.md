<div align="center">

<img src="client/src-tauri/icons/icon.png" width="96" alt="GameTalk" />

# GameTalk

**群聊长在游戏画面上，而不是逼你切窗口。**

[![Release](https://img.shields.io/github/v/release/aocac/GameTalk?style=flat-square&label=%E6%9C%80%E6%96%B0%E7%89%88)](https://github.com/aocac/GameTalk/releases/latest)
[![CI](https://img.shields.io/github/actions/workflow/status/aocac/GameTalk/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/aocac/GameTalk/actions/workflows/ci.yml)
[![平台](https://img.shields.io/badge/%E5%B9%B3%E5%8F%B0-Windows%20%7C%20Linux%20%7C%20macOS-blue?style=flat-square)](https://github.com/aocac/GameTalk/releases/latest)
[![License: MIT](https://img.shields.io/badge/%E8%AE%B8%E5%8F%AF%E8%AF%81-MIT-green?style=flat-square)](LICENSE)

[下载客户端](https://github.com/aocac/GameTalk/releases/latest) · [部署自己的服务器](#自托管服务端) · [服务器配置](#服务器配置参考) · [常见问题](#常见问题) · [报告问题](https://github.com/aocac/GameTalk/issues)

</div>

---

## 为什么做 GameTalk

打排位的时候，队友在群里喊「绕后」，你 Alt+Tab 切出去看一眼，切回来屏幕灰了半秒，团战已经打完了。用语音？不是每局都方便开麦，也不是每个人都想开麦。

所以把打字这个环节从「另一个窗口」搬进游戏画面：

```
按 Alt+G ──► 屏幕底部弹出输入框 ──► 打字回车 ──► 输入框自动关闭，焦点还给游戏
                                                    │
队友那边 ◄──────────── 消息经服务器实时推送 ──────────┘
    │
    └──► 他们的消息以「完全透明、点击穿透」的悬浮层叠在你的游戏画面上，附带一声提示
```

全程双手不离键盘。退出游戏，它又是一个完整的聊天客户端：房间、好友、私聊、表情包、图片、屏幕共享，都在。

<table>
  <tr>
    <td width="50%" align="center">
      <img src="docs/ui-chat-owner.png" alt="房间聊天" /><br />
      <sub><b>房间聊天</b>：多房间预览 · 成员在线状态 · 图片消息 · @提及高亮</sub>
    </td>
    <td width="50%" align="center">
      <img src="docs/ui-dm-chat-b.png" alt="好友私聊" /><br />
      <sub><b>好友私聊</b>：一对一对话 · 在线状态 · 未读角标 · 编辑 / 撤回 / 引用 / 图片</sub>
    </td>
  </tr>
</table>

<details>
<summary><b>更多截图</b></summary>

<table>
  <tr>
    <td width="50%" align="center">
      <img src="docs/ui-friends.png" alt="好友管理" /><br />
      <sub><b>好友管理</b>：申请区 · 好友列表 · 单击资料页 · 双击私聊</sub>
    </td>
    <td width="50%" align="center">
      <img src="docs/ui-dm-unread.png" alt="私聊会话" /><br />
      <sub><b>私聊会话</b>：侧栏会话列表 · 未读角标 · 最新消息预览</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" align="center">
      <img src="docs/ui-member-menu.png" alt="成员右键菜单" /><br />
      <sub><b>成员右键菜单</b>：@提及 / 加好友 / 禁言档位 / 移出房间</sub>
    </td>
    <td width="50%" align="center">
      <img src="docs/ui-settings-notify.png" alt="通知设置" /><br />
      <sub><b>通知设置</b>：Windows 系统通知三档可调 · 提示音同页管理</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" align="center">
      <img src="docs/ui-room-context-menu.png" alt="房间右键菜单" /><br />
      <sub><b>房间右键菜单</b>：复制邀请码 / 邀请链接 / 退出房间</sub>
    </td>
    <td width="50%" align="center">
      <img src="docs/ui-profile.png" alt="个人资料" /><br />
      <sub><b>个人资料</b>：头像 · 昵称 · 个性签名 · 注册时间</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" align="center">
      <img src="docs/ui-stickers.png" alt="云表情包" /><br />
      <sub><b>云表情包</b>：个人跨设备同步 · 群共享表情库</sub>
    </td>
    <td width="50%" align="center">
      <img src="docs/ui-login.png" alt="登录页" /><br />
      <sub><b>登录页</b>：注册 / 登录 / 离线试用</sub>
    </td>
  </tr>
</table>

</details>

## 游戏模式

默认快捷键 `Alt+G`，也可以自己录制组合键。输入框弹出在屏幕底部，Enter 发送、Esc 取消，发完焦点自动交还给游戏，不会抢游戏的按键。中文输入法组词到一半按 Enter 不会把半截拼音发出去。

队友的消息以悬浮层实时叠在游戏画面上。背景是全透明的，不是半透明黑框；鼠标点击完全穿透，不挡操作。位置有六种预设，也可以拖到屏幕任意角落，缩放 50%–200%，停留几秒自动消失。你在主窗口里编辑或撤回一条消息，悬浮层同步更新。不想看的话，设置里有个总开关，关掉之后悬浮层根本不会被创建。

离开游戏时，消息改走 Windows 系统通知，三档可调：全部消息、只弹 @我和私聊、静默。点通知回到窗口后会自动跳到对应的会话——但你正在打草稿的时候它不打断。

这套能力依赖 Win32 的全局快捷键和前台焦点 API，只在 Windows 客户端提供；悬浮层还要求游戏用无边框窗口化运行，全屏独占会把它盖住。Linux 和 macOS 客户端的聊天功能是完整的，只是没有游戏模式。

## 聊天

房间、好友、私聊三块。

房间用 8 位邀请码拉人，进了就是永久成员。也可以生成邀请链接——能设有效期、限使用次数、随时吊销——发给朋友点一下就进房。房主能移出成员、限时禁言（10 分钟到 30 天）。每个房间有独立的群共享表情库，成员共同上传，全群可用，个人还有一份跨设备同步的云表情包。

消息方面，图片自动压缩上传（GIF 保动画），点开灯箱缩放保存；@提及打字时弹补全，被点到的有独立角标；引用、编辑（双端实时同步「已编辑」标记）、撤回（自己撤和房主代撤的文案不同）、转发（右键转到任意房间或好友，服务端代为复制并标注「来自哪里」）都支持。消息按发送者连发自动分组，历史可以向上翻页，断线重连后自动补齐离线消息，每个会话有独立的输入草稿。

好友按用户名或 `#短 ID` 查找，申请同意流，资料页带个性签名。私聊是独立的消息通道，非好友互相看不到历史。在线状态实时推送，好友列表和会话列表都有在线点。

## 屏幕共享

房间内一键共享屏幕。画面在成员之间 P2P 直传，服务器只转发建立连接用的信令，视频流量不经过你的服务器。观看的人会得到一个独立的系统窗口，拖动缩放随意，多人同时共享就开多个窗。有人开共享时，其他人先看到一条提示，点「观看」才建立连接，不会突然被塞一脸画面。上行码率约 4Mbps 封顶，带宽吃紧时自动降分辨率保帧率。

跨网络的限制要提前说清楚：P2P 依赖 NAT 打洞，两边都是对称 NAT 时直连就是不通，这是 WebRTC 的物理限制。解决办法是服务器管理员自建一个 coturn 中继（[部署文档](docs/deployment.md)第 9 节有完整步骤），客户端自动从服务端拿限时凭据走中继。中继密钥只存在服务端，凭据按用户签发、一小时有效，不会被拿去跑别的流量。

画面采集只在 Windows（WebView2）上提供，观看端三平台都可以。

## 安装客户端

前往 [**Releases**](https://github.com/aocac/GameTalk/releases/latest) 下载对应平台安装包：

| 平台 | 格式 |
|---|---|
| Windows | `-x64-setup.exe`（推荐，内置全部依赖） |
| Linux | `.deb` / `.AppImage` |
| macOS | `.dmg`（Apple Silicon） |

升级不用先卸载，直接运行新安装包原地覆盖，运行中的旧版本会被安装器自动结束。

## 自托管服务端

服务器只有你自己：消息、成员、媒体都存在你自己的 PostgreSQL 里，没有第三方。客户端安装包只有 2.3MB，填上服务器地址就能用。

```bash
git clone https://github.com/aocac/GameTalk
cd GameTalk/docker
bash deploy.sh        # 首次运行生成 .env，填入域名后再跑一次即完成
```

完成后得到一个 `https://你的域名` 的服务（Caddy 自动签发 HTTPS/WSS 证书）。部署脚本会顺手装好每日数据库备份：`pg_dump` 全量 + 完整性校验 + 14 天轮转 + systemd timer，Windows 管理机侧还有定时异地拉取脚本（SHA256 校验），细节见[部署文档](docs/deployment.md)。

### 服务器配置参考

所有配置经环境变量（`docker/.env`）管理，默认值开箱即用：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `JWT_SECRET` | （生产必填） | 登录令牌签名密钥；生产模式未设置或用开发默认值将拒绝启动 |
| `JWT_EXPIRES_IN` | `7d` | 登录令牌有效期 |
| `POSTGRES_PASSWORD` | （deploy.sh 生成） | 数据库密码 |
| `CORS_ORIGIN` | `*` | 允许的跨域来源，逗号分隔 |
| `RATE_LIMIT_MAX` | `300` | REST 全局限流（每 IP 每分钟） |
| `RATE_LIMIT_AUTH_MAX` | `10` | 注册 / 登录限流（每 IP 每分钟） |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `PORT` / `HOST` | `8787` / `0.0.0.0` | 非 Docker 裸跑时的监听地址 |
| `TURN_SECRET` | （未设置） | 自建 TURN 中继的共享密钥；设置后 `/api/turn` 为登录用户签发限时中继凭据 |
| `TURN_URL` | （未设置） | TURN 地址，逗号分隔，如 `turn:服务器IP:3478,turn:服务器IP:3478?transport=tcp` |

## 安全设计

密码用 argon2 哈希存储，登录令牌是 JWT（HS256），生产模式强制服务端设置独立密钥。传输全程 HTTPS/WSS（Caddy 自动签证书），REST 接口全部要鉴权。

防滥用：REST 全局限流每 IP 每分钟 300 次，注册登录单独限 10 次；WebSocket 单连接限流每 5 秒 25 条，单帧 64KB 上限，30 秒心跳、70 秒无响应清连接。图片和头像走 UUID 端点（不可枚举），上传校验文件魔数与大小。TURN 凭据按用户限时签发，密钥不进客户端。

数据都在你自己的库里，每日备份保留 14 天。

## 架构与技术栈

| 层 | 选型 |
|---|---|
| 客户端 | [Tauri 2](https://v2.tauri.app/) + [React 19](https://react.dev/) + TypeScript + [zustand](https://github.com/pmndrs/zustand) |
| 服务端 | Node 22 + [Fastify 5](https://fastify.dev/) + WebSocket + `pg` |
| 数据库 | PostgreSQL 16（生产）；开发测试用 [PGlite](https://github.com/electric-sql/pglite)，与生产同一套 SQL 迁移 |
| 认证 | JWT（HS256）+ argon2 |
| 部署 | Docker Compose + [Caddy](https://caddyserver.com/) |
| 测试 | vitest（含真实 WebSocket 集成）+ ESLint + CI 四道门禁 |

客户端是五个窗口入口的 Tauri 应用：主窗口（聊天）、快捷输入框（游戏内）、消息悬浮层（游戏内）、设置窗口、屏幕共享观看窗，游戏模式负责它们的呼出、定位与焦点恢复。

```
 游戏画面上：                    桌面：
 ┌─────────────────┐           ┌────────────────────────────┐
 │ 消息悬浮层（透明） │           │  主窗口：房间/好友/私聊/共享   │
 └────────▲────────┘           │  设置窗口：通知/覆盖/游戏模式  │
          │ 实时推送             └─────────────▲──────────────┘
 ┌────────┴────────┐                         │ HTTPS/WSS
 │ 快捷输入框        │      ┌──────────────────┴───────────────┐
 │ (Alt+G 呼出)     │      │  你的服务器：Fastify + PostgreSQL  │
 └─────────────────┘      │  WS 广播 · 信令透传 · 每日备份      │
                          └──────────────────┬───────────────┘
                                             │ WebRTC（屏幕共享媒体）
                                     成员之间 P2P 直连，不通时经 TURN
```

## 本地开发

```bash
# 服务端（PGlite 零依赖数据库，默认 127.0.0.1:8787）
cd server && npm install && npm run dev

# 客户端（Tauri 桌面应用，需要 Rust + MSVC）
cd client && npm install && npm run tauri dev

# 测试 / 检查（两个目录各自执行）
npm test && npm run lint && npm run typecheck
```

测试基线：服务端 **69** 例（PGlite 内存库 + 真实 WebSocket 集成测试）、客户端 **17** 例。仓库里另有 12 个双账号浏览器回归脚本（`dev/e2e-*.mjs`），覆盖私聊、编辑、表情、通知跳转、邀请链接、屏幕共享这些核心流程。CI 每次推送跑四道门禁：服务端测试、客户端构建、Rust 编译、Docker 镜像。

数据库结构演进是 15 个纯 SQL 迁移文件（`server/migrations/`），启动时自动应用——PGlite 和生产 PostgreSQL 跑的是同一份 SQL。

## 常见问题

<details>
<summary><b>连不上服务器？</b></summary>

登录页会显示具体原因。自检顺序：服务器地址是否带了尾斜杠（现在会自动纠正，但旧服务器请升级）；服务器是否健康（`https://你的域名/health` 应返回 JSON）；客户端网络是否需要代理（设置里有 HTTP 代理开关）。
</details>

<details>
<summary><b>游戏里看不到悬浮层？</b></summary>

确认三点：游戏以无边框窗口化运行（全屏独占会盖住悬浮层）；设置里「屏幕覆盖」开关已打开；快捷键没被游戏吞掉（换一个不冲突的组合键试试）。
</details>

<details>
<summary><b>屏幕共享跨网络连不上或黑屏？</b></summary>

跨网络 P2P 依赖 NAT 打洞，对称 NAT 的网络直连不通——这是 WebRTC 的物理限制，不是 bug。两端在同一网络时天然直连；跨网络需要服务器管理员自建 coturn 中继（部署文档第 9 节），客户端会自动走中继。没有 TURN 的情况下，同网可用、跨网受限。
</details>

<details>
<summary><b>数据都存在哪？换电脑怎么办？</b></summary>

一切在服务器：消息、成员、媒体、表情都在你自托管的 PostgreSQL 里，客户端本地只有登录态和界面偏好。换电脑登录即恢复。数据库每日自动备份（保留 14 天），Windows 端可配置定时异地拉取，恢复步骤见部署文档。
</details>

<details>
<summary><b>macOS / Linux 能用吗？</b></summary>

聊天功能完整可用（有对应平台安装包）；游戏模式（全局快捷键、悬浮层、焦点恢复）和屏幕共享的画面采集依赖 Windows API，仅 Windows 客户端提供。
</details>

## 路线图

- [x] 游戏模式（快捷键 / 输入框 / 透明悬浮层 / 焦点恢复）
- [x] 多房间并行 + 未读角标
- [x] 好友系统 + 好友私聊 + 成员在线状态
- [x] 消息编辑 / 撤回归属 / 转发 / 引用
- [x] 云表情包 + 群共享表情库
- [x] 邀请链接（可过期 / 限次数 / 深链加入）
- [x] 房间内 P2P 屏幕共享 + 独立观看窗 + 自建 TURN 兜底
- [x] 通知点击跳转到对应会话
- [ ] 消息图片对象存储备份（冷备到 S3 / COS）
- [ ] macOS / Linux 的游戏模式适配

## 参与贡献

欢迎 Issue 和 PR。提交前请跑通 `npm test && npm run lint`（两个目录）；UI 改动请附双账号浏览器自验截图。

## 许可证

[MIT](LICENSE)
