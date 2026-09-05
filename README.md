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

## 它解决什么问题

打排位时队友在群里喊「绕后」，你 Alt+Tab 切出去看一眼，切回来屏幕灰了半秒，团战已经打完。用语音？不是每局都方便开麦，也不是每个人都想开麦。

GameTalk 的思路很直接：**把打字的环节从「另一个窗口」搬进游戏画面里**。

```
按 Alt+G ──► 屏幕底部弹出输入框 ──► 打字回车 ──► 输入框自动关闭，焦点还给游戏
                                                    │
队友那边 ◄──────────── 消息经服务器实时推送 ──────────┘
    │
    └──► 他们的消息以「绝对透明、点击穿透」的悬浮层直接叠在游戏画面上，附带提示音
```

全程双手不离键盘，视线不离游戏。退出游戏，它又是一个完整的聊天客户端：房间、好友、私聊、表情包、图片、屏幕共享，一样不少。

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

## 游戏模式：它存在的理由

这是 GameTalk 和普通聊天软件的分界线，值得单独一节。

**呼出与发送。** 默认按 `Alt+G`（可改键，支持录制），屏幕底部弹出输入框，回车发送、Esc 取消。发送完焦点自动交还给游戏——不用点鼠标，不抢游戏按键。快捷键录制兼容中文输入法：正在组词的 Enter 不会把半截拼音发出去。

**绝对透明的悬浮层。** 队友的消息实时叠加在游戏画面上：背景完全透明（不是半透明黑框），鼠标点击完全穿透（不挡点击、不挡瞄准），位置有六种预设、也可以按住拖到任意角落，缩放 50%–200%，停留几秒自动消失。你在游戏里编辑或撤回一条消息，悬浮层上同步更新。给不想看消息的人留了一个总开关，关掉后悬浮层彻底不创建。

**提示音与通知。** 收到消息播放短促提示音（WebAudio 合成，零音频资源）；离开游戏时改走 Windows 系统通知，三档可调——全部消息 / 只弹 @我 和私聊 / 静默。点通知切回窗口后会自动定位到对应会话；你正在输入草稿时它不打断。

**限界，说实话。** 游戏模式依赖 Win32 全局快捷键与前台窗口焦点 API，**仅限 Windows**；Linux / macOS 客户端聊天功能完整，但没有游戏模式。悬浮层方案要求游戏以无边框窗口化运行（全屏独占会盖住悬浮层）。

## 聊天，该有的都有

**房间与成员。** 创建房间 → 8 位邀请码拉人 → 一次加入永久保留。也可以生成**邀请链接**（可设有效期、可限使用次数、可吊销），发给朋友点一下就进房。房主可以移出成员、限时禁言；每个房间有独立的**群共享表情库**，成员共同贡献、全群可用。

**消息能力。** 文字、图片（自动压缩，灯箱查看/缩放/保存，GIF 保动画）、表情（精选 Unicode + 个人云表情包，上限 24 个，换设备自动同步）、@提及（打 @ 弹补全，被提及的人有独立角标）、引用回复、**编辑**（双端实时同步「已编辑」）、**撤回**（自己撤 / 房主代撤，文案分明）、**转发**（右键转到任意房间或好友，服务端代为复制并标注来源）。消息按发送者连发自动分组，历史支持向上翻页，断线重连后自动补齐离线消息，每个会话独立的输入草稿。

**好友与私聊。** 好友申请-同意流、资料页（个性签名 / ID 复制）、在线状态实时推送。私聊是独立的消息通道，非好友互相看不见历史。侧栏消息预览、未读角标、QQ 式连发分组这些细节都在。

**界面。** QQ NT 式三栏：左侧图标导航、中间浅色会话列表、右侧聊天区 + 成员面板。深浅配色克制克制再克制——没有渐变，没有发光，没有大圆角阴影堆砌。

## 屏幕共享：P2P，不上传到服务器

房间内一键共享屏幕，**画面不走你的服务器**——服务端只转发 WebRTC 信令（谁给谁的连接请求），视频流在成员之间点对点直传。

- 观看是**独立系统窗口**：可以拖动、缩放、最小化，不挤占聊天窗口；多人同时共享时各开各的窗
- **显式加入**：别人开共享时你看到一条「某某正在共享屏幕」的提示，点「观看」才建立连接，不会突然被塞一脸画面
- 带宽自适应：上行约 4Mbps 封顶，带宽不足自动降分辨率保帧率
- **跨网络兜底**：直连打不通（典型如对称 NAT）时，自动经服务器管理员自建的 TURN 中继转发——中继凭据由服务端按用户签发、限时 1 小时，密钥不出服务端，别想拿它当免费代理
- 限界：共享者需要 Windows（WebView2 屏幕捕获）；观看端三平台均可

## 安装客户端

前往 [**Releases**](https://github.com/aocac/GameTalk/releases/latest) 下载对应平台安装包：

| 平台 | 格式 |
|---|---|
| Windows | `-x64-setup.exe`（推荐，内置全部依赖） |
| Linux | `.deb` / `.AppImage` |
| macOS | `.dmg`（Apple Silicon） |

**升级无需卸载**：直接运行新安装包原地覆盖，运行中的旧版本会被安装器自动结束。游戏模式仅限 Windows；Linux / macOS 聊天功能完整。

## 自托管服务端

服务器只有你自己：消息、成员、媒体都存在你自己的 PostgreSQL 里，没有任何第三方。安装包只有 2.3MB，客户端连上服务器地址就能用。

```bash
git clone https://github.com/aocac/GameTalk
cd GameTalk/docker
bash deploy.sh        # 首次运行生成 .env，填入域名后再跑一次即完成
```

完成后你会得到一个 `https://你的域名` 的服务（Caddy 自动签发 HTTPS/WSS 证书），填进客户端「设置 → 服务器地址」。和朋友共用一台服务器，邀请码互通。

部署脚本顺手装好**每日数据库自动备份**（`pg_dump` 全量 + 完整性校验 + 14 天轮转 + systemd timer），Windows 侧还有一个定时异地拉取脚本（SHA256 校验）。细节见[部署文档](docs/deployment.md)。

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
| `TURN_SECRET` | （未设置） | 自建 TURN 中继的共享密钥（coturn `use-auth-secret` 模式）；设置后 `/api/turn` 为登录用户签发限时中继凭据 |
| `TURN_URL` | （未设置） | TURN 地址，逗号分隔，如 `turn:服务器IP:3478,turn:服务器IP:3478?transport=tcp` |

## 安全设计

- **密码**：argon2 哈希存储；登录令牌 JWT（HS256），生产模式强制服务端设置独立密钥
- **传输**：Caddy 自动 HTTPS/WSS；REST 全部 JWT 鉴权
- **滥用防护**：REST 全局限流 300 次/分（登录注册单独 10 次/分防爆破）；WS 单连接限流 25 条/5 秒、单帧 64KB 上限、30 秒心跳 / 70 秒无响应清理死连接
- **媒体**：图片与头像走 UUID 端点（不可枚举、免认证带 immutable 缓存），上传校验魔数与大小（头像 ≤3MB、图片 ≤5MB）
- **中继**：TURN 密钥只存服务端，凭据按用户、限时签发——不会变成开放的流量代理
- **数据归属**：一切存你自己的库；库有每日备份，备份有异地副本

## 技术栈与架构

| 层 | 选型 |
|---|---|
| 客户端 | [Tauri 2](https://v2.tauri.app/) + [React 19](https://react.dev/) + TypeScript + [zustand](https://github.com/pmndrs/zustand) |
| 服务端 | Node 22 + [Fastify 5](https://fastify.dev/) + WebSocket + `pg` |
| 数据库 | PostgreSQL 16（生产）；开发测试用 [PGlite](https://github.com/electric-sql/pglite)，与生产同一套 SQL 迁移 |
| 认证 | JWT（HS256）+ argon2 |
| 部署 | Docker Compose + [Caddy](https://caddyserver.com/) |
| 测试 | vitest（含真实 WebSocket 集成）+ ESLint + CI 四道门禁 |

客户端是五个窗口入口的 Tauri 应用：主窗口（聊天）、快捷输入框（游戏内）、消息悬浮层（游戏内）、设置窗口、屏幕共享观看窗。游戏模式负责三者的呼出、定位与焦点恢复。

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

测试基线：服务端 **69** 例（PGlite 内存库 + 真实 WebSocket 集成测试）、客户端 **17** 例（含连接管理器单测与端到端集成）。仓库里另有 12 个双账号浏览器回归脚本（`dev/e2e-*.mjs`），覆盖私聊、编辑、表情、通知跳转、邀请链接、屏幕共享等核心流程；UI 改动先跑一遍再交付。CI 每次推送跑四道门禁：服务端测试、客户端构建、Rust 编译、Docker 镜像。

数据库结构演进是 15 个纯 SQL 迁移文件（`server/migrations/`），启动时自动应用——PGlite 与生产 PostgreSQL 跑的是同一份 SQL。

## 常见问题

<details>
<summary><b>连不上服务器？</b></summary>

登录页会显示具体原因。自检顺序：服务器地址是否带了尾斜杠（现在会自动纠正，但旧服务器请升级）；服务器是否健康（`https://你的域名/health` 应返回 JSON）；客户端网络是否需要代理（设置里有 HTTP 代理开关）。
</details>

<details>
<summary><b>游戏里看不到悬浮层？</b></summary>

确认三点：游戏以无边框窗口化运行（全屏独占会盖住悬浮层）；设置里「屏幕覆盖」开关已打开；窗口高度 ≥600px 时屏幕共享选择器才可用（WebView2 限制）。快捷键被游戏吞掉的话，换一个不冲突的组合键。
</details>

<details>
<summary><b>屏幕共享跨网络连不上或黑屏？</b></summary>

跨网络 P2P 依赖 NAT 打洞，对称 NAT 的网络直连不通——这是 WebRTC 的物理限制，不是 bug。两种解法：两端在同一网络时天然直连；跨网络时由服务器管理员自建 [coturn](https://github.com/coturn/coturn) 中继并在服务端配置 `TURN_SECRET` / `TURN_URL`（部署步骤见[部署文档](docs/deployment.md)），客户端会自动拿到限时凭据走中继。没有 TURN 的情况下，同网可用、跨网受限。
</details>

<details>
<summary><b>数据都存在哪？换电脑怎么办？</b></summary>

一切在服务器：消息、成员、媒体、表情都在你自托管的 PostgreSQL 里，客户端本地只有登录态和界面偏好。换电脑登录即恢复。数据库每日自动备份（保留 14 天），Windows 端可配置定时异地拉取，恢复步骤见部署文档。
</details>

<details>
<summary><b>macOS / Linux 能用吗？</b></summary>

聊天功能完整可用（有对应平台安装包）；游戏模式（全局快捷键、悬浮层、焦点恢复）与屏幕共享的画面采集依赖 Windows API，仅 Windows 客户端提供。
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
