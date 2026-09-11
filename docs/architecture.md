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
| 客户端 | Tauri 2 + React 19 + TS + Vite | 安装包 ~2.4MB；系统级全局快捷键、透明置顶窗口原生支持；Rust 侧极小 |
| 服务端 | Node 22 + Fastify 5 + @fastify/websocket | 轻量、WebSocket 一等公民、TS 全栈类型统一 |
| 数据库 | PostgreSQL 16 | 稳定；`pg` 直连 + 纯 SQL migration，无 ORM 心智负担 |
| 开发/测试库 | PGlite (WASM PostgreSQL) | 本机无 PG/Docker 时的真实 SQL 环境；与生产同源 migration |
| 认证 | JWT (HS256, jose) + argon2 | 无状态、可水平扩展；密码哈希行业标准 |
| 部署 | Docker + docker-compose + Caddy | Linux 一键部署；Caddy 自动 HTTPS/WSS。**已有 nginx/宝塔面板的机器不装 Caddy**，改用 nginx 反代（占位符：见 deployment 第 3.2 节），compose 里只保留 postgres + server |

## 3. 目录结构

```
gametalk/
├── client/                  # Tauri 2 桌面客户端
│   ├── src/                 # React 前端
│   │   ├── app/             # 基础能力：types / ws / api / settings / gameMode / audio / screenShare
│   │   ├── stores/          # zustand 状态（auth / chat / friends）
│   │   ├── App.tsx          # 主窗口 UI（登录 / 图标导航 rail + 会话列表列 / 聊天区 / 成员面板）
│   │   ├── input.tsx        # 快捷输入框窗口入口（游戏模式）
│   │   ├── overlay.tsx      # 消息浮层窗口入口
│   │   ├── settings.tsx     # 设置窗口入口
│   │   ├── screen.tsx       # 屏幕共享观看窗入口
│   │   ├── share.tsx        # 屏幕采集窗入口
│   │   └── buildInfo.ts     # 构建标识（vite define 注入）
│   ├── scripts/             # build-id.mjs（构建唯一标识）/ copy-artifacts.mjs
│   └── src-tauri/           # Rust 壳（托盘 / 单实例 / quit_app / set_proxy / 采集条隐藏）
├── server/                  # Fastify 服务端
│   ├── src/
│   │   ├── routes/          # REST 路由（health / auth / rooms / invites / friends / dm / stickers / media / turn）
│   │   ├── ws/              # WS 网关（认证 + 房间广播 + 花名册/在线状态 + 信令透传 + 限流 + 心跳清理）
│   │   ├── db/              # pg/PGlite 抽象 + migration 执行器
│   │   └── lib/             # jwt / password / image / invite / avatar / validate / envfile
│   ├── migrations/          # 纯 SQL migration（生产与 PGlite 同源）
│   └── test/                # vitest 单测 + 集成测试
├── docker/                  # 生产部署 compose、Caddyfile、部署/备份/coturn 脚本
├── dev/                     # 浏览器回归脚本（e2e-*.mjs）与截图脚本
└── docs/                    # 本文档 / 部署 / 测试
```

## 4. 实时通信协议（WS）

**连接**：`/ws`，客户端连接成功后发送 `hello` 携带 JWT token，服务端校验并绑定用户。

**账号与设备（单设备登录）**：账号是全站共用的，同一账号多端并存会派生出一片问题——共享登记按 `userId` 唯一（第二台一共享就覆盖第一台、还能把第一台停掉）、乐观消息按房间 FIFO 校正被同账号另一端的广播顶掉、REST 退房按 `userId` 清订阅导致其它端连坐。因此约定：**一个账号同一时刻只有一台设备在线**。

- 客户端在 localStorage 持久化一个随机 `deviceId`（`client/src/app/device.ts`），主窗 `ChatSocket` 与采集/观看窗 `SignalSocket` 的 `hello` 都带上同一值。限制落在**设备**维度而不是连接维度——同一个客户端实例本来就会为采集窗另开一条信令 WS，按连接限会把自己的窗口踢掉。
- 服务端 `activeDevices: userId -> {deviceId, sockets}`；新设备 `hello` 时若设备不同，先向旧设备的所有连接发 `{code:'session_replaced'}` 再 `close(4001)`，然后登记新设备。连接断开时释放（该设备最后一个连接断开才算下线）。
- 旧客户端不带 `deviceId` → 归到 `LEGACY_DEVICE`，同账号的多个旧连接视为同一台设备，不会互相踢（向后兼容）。
- 客户端收到 `session_replaced` 后清凭据回登录页、显示阻断式提示，并**立刻停掉重连**——不停的话两台设备会互相顶号形成无限对踢。
- **写脚本/测试注意**：用同一账号开裸 WebSocket 时必须带同一个 `deviceId`，否则会被服务端当成另一台设备把主连接顶掉。

**客户端 → 服务端**
```json
{"type":"hello","payload":{"token":"<JWT>","deviceId":"<本机持久化随机串>"}}
{"type":"room:join","payload":{"roomId":"..."}}
{"type":"room:leave","payload":{"roomId":"..."}}
{"type":"room:delete","payload":{"roomId":"..."}}
{"type":"member:kick","payload":{"roomId":"...","userId":"..."}}
{"type":"member:mute","payload":{"roomId":"...","userId":"...","minutes":10}}
{"type":"member:unmute","payload":{"roomId":"...","userId":"..."}}
{"type":"message:send","payload":{"roomId":"...","text":"hi","mentions":["<userId>"],"mediaUrl":"/api/media/<uuid>"}}
{"type":"message:recall","payload":{"roomId":"...","messageId":"..."}}
{"type":"message:edit","payload":{"roomId":"...","messageId":"...","text":"改后内容"}}
{"type":"message:forward","payload":{"source":"room|dm","messageId":"...","targetRoomId":"..."}}
{"type":"message:forward","payload":{"source":"room|dm","messageId":"...","targetUserId":"..."}}
{"type":"dm:send","payload":{"to":"<userId>","text":"hi","mediaUrl":"/api/media/<uuid>","replyTo":"..."}}
{"type":"dm:recall","payload":{"messageId":"..."}}
{"type":"dm:edit","payload":{"messageId":"...","text":"改后内容"}}
{"type":"screen:start","payload":{"roomId":"..."}}
{"type":"screen:stop","payload":{"roomId":"..."}}
{"type":"screen:signal","payload":{"roomId":"...","to":"<userId>","data":{...WebRTC SDP/ICE...}}}
{"type":"ping"}
```

**服务端 → 客户端**
```json
{"type":"hello:ok","payload":{"me":{"id":"...","username":"Alice","avatarUrl":"https://.../api/avatars/..."}}}
{"type":"room:joined","payload":{"roomId":"...","members":[{"id":"...","username":"...","online":true,"mutedUntil":null}],"screenShares":[{"userId":"...","username":"Alice"}]}}
{"type":"member:joined","payload":{"roomId":"...","member":{...}}}
{"type":"member:left","payload":{"roomId":"...","userId":"...","username":"..."}}
{"type":"member:kicked","payload":{"roomId":"...","userId":"...","username":"..."}}
{"type":"member:muted","payload":{"roomId":"...","userId":"...","mutedUntil":"..."}}
{"type":"member:unmuted","payload":{"roomId":"...","userId":"..."}}
{"type":"message:new","payload":{"roomId":"...","message":{...,"mentions":[{"id":"...","username":"..."}],"kind":"text|image","mediaUrl":"...","forwardedFromLabel":"来自 群A · 张三"}}}
{"type":"message:recalled","payload":{"roomId":"...","messageId":"...","operatorId":"...","operatorUsername":"..."}}
{"type":"message:edited","payload":{"roomId":"...","messageId":"...","text":"...","editedAt":"..."}}
{"type":"dm:new","payload":{"message":{"id":"...","from":"...","to":"...","username":"...","text":"...","kind":"text|image","mediaUrl":null,"recalled":false}}}
{"type":"dm:recalled","payload":{"messageId":"...","from":"...","to":"..."}}
{"type":"dm:edited","payload":{"messageId":"...","from":"...","to":"...","text":"...","editedAt":"..."}}
{"type":"screen:started","payload":{"roomId":"...","userId":"...","username":"..."}}
{"type":"screen:stopped","payload":{"roomId":"...","userId":"..."}}
{"type":"screen:signal","payload":{"from":"<userId>","roomId":"...","data":{...WebRTC SDP/ICE/request/bye...}}}
{"type":"room:deleted","payload":{"roomId":"..."}}
{"type":"friend:request","payload":{"requestId":"...","from":{...}}}
{"type":"friend:accepted","payload":{"user":{...}}}
{"type":"friend:declined","payload":{"userId":"..."}}
{"type":"friend:removed","payload":{"userId":"..."}}
{"type":"presence:friend","payload":{"userId":"...","online":true}}
{"type":"error","payload":{"code":"...","message":"...","roomId":"...","mutedUntil":"..."}}
{"type":"pong"}
```

**房间模型**：服务端内存 `roomId -> userId -> {sockets}`。消息先持久化再广播；`joinRoom` 幂等（重复 join 也回 `room:joined`，客户端有 2s 订阅看门狗自愈）；`room:delete` 仅房主可调用，级联删除、广播 `room:deleted` 并清掉所有连接的该房间订阅；`member:kick` 仅房主可调用，把成员移出房间（DB 删除 + 全员通知 `member:kicked` + 被踢者订阅清理），被踢者客户端自动移除房间并切换。**REST 退房同样会清实时订阅**（`dropRoomSubscription`），否则旧连接还能继续发送/撤回。**房主不能退房**（回 `owner_cannot_leave`），只能删房，避免房间失去管理权。**客户端订阅其全部房间**（非活跃房间也能实时收消息，UI 显示未读角标，浮层标注来源房间）。

**错误码语义**：`not_in_room` 专指「你自己不在该房间」，客户端据此把房间从本地移除；「操作目标不在房间」（踢人/禁言/信令对端）用独立的 `target_not_in_room`，客户端只提示、不动自己的房间列表；**`room_gone`** 用于房间已在别处被解散（断线期间被删、离线队列重放、多端竞态）——WS 层识别 `room_id` 外键冲突（23503）后清理该连接的陈旧订阅，返回 `{code:'room_gone', roomId, message}`，客户端据此移除本地幽灵房间并提示已自动切换。PG 入参/外键类错误由全局错误处理映射：`22P02`（非法 UUID）→ 400、`23503`（外键不存在）→ 404，不再变成 500。

**历史分页**：`GET /api/rooms/:id/messages` 与 `GET /api/dm/:peerId/messages` 都是游标分页（`before` + `limit`，默认 50、上限 100）。实现上多取一条用于判断 `hasMore`，**保留最新的 limit 条**（丢弃最旧的那条多取项）；游标子查询限定在本房间/本会话内。客户端首屏加载与「加载更早」都依赖这个语义。

**花名册与在线状态**：房间成员关系持久于 DB（`room_members`），`room:joined` 回执返回**完整花名册**（含离线成员）+ 实时 `online` 标记（由内存连接表推导）。`member:joined` = 新成员进房或离线成员上线；`member:left` = 该用户最后一个连接断开（语义为「离线」而非移除，客户端置灰保留）。好友上/下线额外广播 `presence:friend` 给其在线好友。

**提及**：服务端解析消息——客户端显式 picks（成员校验）∪ 文本 `@用户名` 兜底匹配（用户名唯一，按名精确匹配），剔除自己后以 `[{id, username}]` 快照入库（历史渲染不依赖成员表）；广播与历史均携带。被提及者客户端累计 @未读（橙色角标）；Windows 系统通知按设置档位弹出。

**禁言**：`member:mute`（仅房主、1 分钟–30 天、不能禁言自己/房主）写 `room_mutes` 并广播 `member:muted`；`message:send` 对生效中的禁言回 `error(code=muted, mutedUntil)`；到期自动失效（惰性判断），`member:unmute` 提前解除。花名册携带 `mutedUntil` 供全员展示禁言标签。

**图片消息**：客户端先 `POST /api/media`（data URL，≤5MB，魔数校验）取得 `/api/media/<uuid>`，再随 `message:send(kind=image)` 发送。单图走 `mediaUrl`，多图（≤9 张）走 `mediaUrls[]`，服务端把首图同时写进 `media_url` 以兼容旧客户端，完整列表写 `media_urls` JSONB。服务端校验每张媒体必须存在且属于发送者，**或已登记为共享表情**（本房间群表情 / DM 双方任一收藏，支撑「成员贡献、全群使用」的群表情场景；其余引用仍严格拒绝）；空数组不算内容。撤回时 `media_url` 与 `media_urls` 一并清空。读取端点免认证（`<img>` 带不了 Authorization 头），与头像同策略：UUID 不可枚举 + immutable 缓存。

**通知与跳转**：Windows 系统通知按用户档位触发；桌面端通知无点击回调（插件 onAction 仅移动端），等价方案为「通知到达时记录会话定位（pendingNotifyTarget）→ 应用窗口获得焦点时消费并切换会话」，用户输入中不打断。

**表情包**：`POST/GET/DELETE /api/stickers`（个人云表情，媒体归属校验 + 24 上限 + 幂等）、`POST/GET/DELETE /api/rooms/:id/stickers`（房间共享，成员资格校验，删除 = 添加者或房主）。客户端表情面板三页签：表情 / 我的表情包（云同步，本地旧数据自动迁移）/ 群表情（按房间隔离）。

**好友**：`friendships`（pending/accepted，双向唯一）；支持 userId / 用户名 / `#8 位短 ID` 查找；反向申请等价于互加。实时事件（`friend:request/accepted/declined/removed`）经 WS 推送在线方。好友与房间完全分离管理。

**好友私聊（DM）**：仅 accepted 好友可互发（`dm:send` 服务端校验，非好友回 `not_friends`）。独立 `dm_messages` 表（与房间消息分离，无提及/禁言语义），消息含 `from/to/username 快照/kind/media_url/reply_to/recalled`；持久化后向**双方所有连接**广播 `dm:new`（发送者自己也收到，多端一致）。撤回 `dm:recall` 仅发送者本人（无房主概念，他人撤回回 `only_sender`），广播 `dm:recalled`，内容清空。REST：`GET /api/dm/conversations`（DISTINCT ON 聚合每会话最后一条，侧栏预览一次拉齐）、`GET /api/dm/:peerId/messages`（游标分页，非好友 403）。删除好友不删历史（重新加好友后消息仍在，UI 隐藏会话）。客户端：乐观发送 + 按序校正，`activeDmPeerId` 与 `activeRoomId` 互斥表达活跃会话。

**撤回操作者**：`message:recalled` 广播与 REST 历史均携带 `recalledBy`（房主代撤时 ≠ 消息作者）；客户端撤回行据此刻画——自己撤「你撤回了一条消息」、作者撤「XX撤回了一条消息」、房主代撤「房主撤回了 XX 的消息」；侧栏预览同步操作者。旧数据 recalled_by 为空回落作者。

**消息编辑**：`message:edit` / `dm:edit`（仅发送者本人、未撤回、文本非空；他人编辑回 `only_sender`，撤回后不可编辑回 `message_not_found`）。编辑只更新 `text` 并记 `edited_at`（原版本不保留，微信/QQ 式），同时**重算提及**并随 `message:edited` 下发 `mentions`（否则编辑时新增的 @ 永远不生效）；REST 历史与广播均带 `editedAt` 供客户端展示「已编辑」小标。房间与私聊语义一致。

**邀请链接**：区别于 8 位房间邀请码（房间语境内部使用），邀请链接是 16 位长码（熵更高，防脱离房间语境公开传播后被猜测），存 `invite_links`（`expires_at` NULL = 永久、`max_uses` 0 = 不限、`used_count` 计数）。REST：`POST /api/rooms/:id/invites`（成员即可创建，有效期 0–720 小时、次数 0–500）、`GET /api/rooms/:id/invites`（房主看全部、成员看自己）、`DELETE /api/invites/:code`（创建者或房主吊销）、`GET /api/invites/:code`（加入前预览房间名/邀请人/剩余资格）、`POST /api/invites/:code/redeem`（过期/次数耗尽回 410；已是成员则幂等入房且不计数）。客户端注册 `gametalk://` 深链协议（tauri-plugin-deep-link + capabilities）：运行中点击链接走单实例回调 → Rust emit `deep-link-url` → 前端解析 code 弹确认入房；未登录时代码暂存 localStorage，登录后补处理。

**消息转发**：`message:forward` 由服务端校验源消息可见性后**代为复制**到新会话，客户端拿不到也不伪造内容——房间消息须为源房间成员、私聊须为对话双方（不可见回 `not_in_room`；撤回消息不可转发）。目标为房间（`targetRoomId`）或好友（`targetUserId`），二者恰好其一（否则 `invalid_input`）；转发进房间复用成员资格 + 禁言校验（等价一条新 `message:send`），转发给好友复用 `dm:send` 的好友校验。文本 / 图片原样带走，**引用与提及不带走**；服务端写 `forwarded_from_label` 展示快照（房间「来自 群A · 张三」/ 私聊「来自 张三 的私聊」），随 `message:new` / `dm:new` 与历史接口透传，客户端渲染「转发」角标。媒体归属：服务端复制 `media_url` 天然绕过发送归属校验（入库时已校验过）。

**屏幕共享**：房间内 1 对 N（同房间可多人各共享一路）的 WebRTC 共享，**媒体流不经服务器**，服务端只做信令透传。WS：`screen:start`（仅房间成员发起，向全房间广播 `screen:started{roomId,userId,username}`）、`screen:stop`（广播 `screen:stopped{roomId,userId}`，各端按 userId 精确移除）、`screen:signal`（按 `to` 定向转发 `{from,roomId,data}`，服务端校验收发双方均为同房间成员——防把媒体信令发给陌生人，且**不解析 data**）。`room:joined` 除完整花名册外返回 `screenShares:[{userId,username}]` 当前快照，晚加入成员据此显示可选的「观看」入口，不自动观看；服务端按 owner socket 清理断开的共享并广播 `screen:stopped`；显式 `screen:stop` 按用户清理（主窗口与采集窗是不同 socket，都代表同一个人）。**一台设备同时只能共享一个房间**：`shareRoomByDevice` 记录设备占用，跨房间第二路回 `already_sharing` + `sharingRoomId`（刻意不复用 `roomId` 字段，否则客户端的错误分支会拿它去回滚乐观消息）；同房间重复 `screen:start`（信令重连后重登记）幂等，只在「新出现的共享」时广播——否则观看端每次重连都会被 `screen:started` 把画面重置掉。信令协议（data 内容，客户端约定）：观看端 `request` → 共享者为其建 sender 连接并回 `offer`（晚加入靠观看端主动请求触发，不做预建 mesh）→ 观看端 `answer` → 双向 `candidate`；观看端关窗发**带 `cid` 的** `bye`（不带 cid 的兜底分支会按用户释放，同账号同时看多路时关一个会误断其它路），共享者只释放那一路连接。**观看为独立系统窗口**（`screen.html` 入口）：MediaStream 不能跨 webview，故观看窗自持一条 WS 信令连接（同源共享 localStorage token）并建立自己的 RTCPeerConnection；关窗（含原生标题栏 X，经 onCloseRequested）先发 `bye` 再关闭。**跨网络兜底（自建 TURN）**：服务器管理员部署 coturn（`use-auth-secret` 模式），服务端经 `GET /api/turn`（登录态）按用户签发限时 1 小时凭据（`username='<到期时间戳>:<userId>'`，`credential=base64(hmac-sha1(TURN_SECRET, username))`）；客户端缓存 55 分钟并作为首选 ICE——密钥不进客户端，中继不会变成无鉴权的开放代理。未配置 `TURN_SECRET`/`TURN_URL` 时接口返回空、客户端仅用 STUN（同网直连可用，跨网对称 NAT 受限）。采集端请求 `audio:true + systemAudio:'include'`，窗口源额外提示 `windowAudio:'window'`（均为 WebView2/Chromium 实验性 hint，最终以原生选择器和返回音轨为准）；`contentHint='motion'`；WebView2 采集要求窗口高度 ≥600px。

**码率策略（v0.8）**：mesh 下每增加一个观看者就多一路编码，所以按「总预算 ÷ 观看人数」分摊（默认 12Mbps，设置可改），单路下限 1.2Mbps；画质档位决定单路上限与取舍——**自动（默认）**按「可用预算/观看人数」选档（≥5Mbps 给清晰优先、≥2.5Mbps 给流畅优先、否则省流量，再叠加实测丢包与 RTT 的自适应系数）、清晰优先（`maxBitrate` 6M / `maintain-resolution`，带宽不足掉帧）、流畅优先（4M / `balanced`，带宽不足降分辨率）、省流量（1.5M / `scaleResolutionDownBy=1.5` / `balanced`）；手动锁定某一档后自适应仍在，但不再换档。房间横幅与观看窗显示**当前生效**的档位（自动档标签形如 `自动·清晰`）。系统声音轨固定 128kbps。每 2s 读 `getStats()`（outbound/inbound-rtp 字节增量、`remote-inbound-rtp` 的丢包与 RTT）驱动自适应系数（丢包 >5% 或 RTT >400ms 下调 25%，最低 60%；恢复后每 4s 上调 15%），变化超过 1% 时重设所有 sender 参数；`setParameters` 被拒时退回「只改码率」重试并在控制条提示。

**中继限码率**：TURN 中继会占用服务器公网出口（媒体先到服务器再转发）。客户端每 2s 的采样会读取选中候选对的类型，一旦本地或对端为 `relay`，单路目标码率被压到服务端下发的 `relayMaxBps`（`TURN_RELAY_MAX_BPS`，默认 1.2Mbps）并在控制条显示「服务器中转」——避免一路 1080p 吃满服务器出口、连带影响聊天流量。服务端建议同时给 coturn 配 `max-bps`（单会话）与 `bps-capacity`（全服，单位字节/秒、上下行分别计）做兜底。

**断线自愈**：ICE `disconnected` 等 2s、`failed` 等 0.5s 触发 `restartIce()`，退避 2/4/8s 最多 4 次，`connected` 后复位。采集窗与观看窗的信令改用 `app/signalSocket.ts`（退避重连 + 心跳 + 半开检测）：重连后采集端重新 `screen:start`、观看端**带原 cid 重发 `request`**——共享端对 `connected/completed/checking/new` 的既有 sender 保持不动，只有已 failed 的才重建，因此信令抖动期间媒体不中断。

**控制条与诊断**：共享建立后采集窗从 1020×720 缩成右下角 **460×104** 的常驻控制条（无边框、置顶、不进任务栏；尺寸以**逻辑像素**为准，下发窗口时乘窗口所在显示器的 `scaleFactor`，否则高 DPI 下会被压扁裁切），内含本地预览（同一 MediaStream）、正在共享、观看人数、实测分辨率/码率/帧率与停止按钮；画质档位/带宽预算/静音提示音都在应用内（房间横幅 + 设置窗口「屏幕共享」页），不占常驻浮窗；数据来自 `ScreenShareManager.snapshot()`，并经 `share:stats` 事件同步给主窗口横幅。观看窗同样显示分辨率/码率/帧率。**已知限制**：无 SFU，上行随观看人数线性增长；无进程级音频隔离。

**用户资料**：`users` 含个性签名 `bio`（≤100 字，PATCH /api/auth/me 维护）；成员卡片经
`GET /api/users/:id`（登录态、UUID 不可枚举）读取公开资料。

**头像分发**：`users.avatar_url` 存 data URL，但所有对外接口（REST 响应 / WS 广播 / 成员表）一律转换
为 `GET /api/avatars/<userId>` 绝对 URL（按请求头推导 base，反代后走 X-Forwarded-Proto），
避免 base64 随每条消息广播与成员表内嵌。

**WS 加固与保活**：
- 单连接限流：5s 滑动窗口最多 25 条消息，超出回 `error(code=rate_limited)`。
- 单帧上限 64KB（`maxPayload`），超限直接断连（close code 1009）。
- 服务端每 30s 发协议层 ping；70s 无 pong 的死连接被 terminate 并清理房间订阅（防"幽灵成员"）。

## 5. 数据库 Schema（migration 演进）

- `migrations/*.sql` 按文件名顺序执行，`_migrations` 表记录已应用版本。
- `001_users`：用户（注册/登录）
- `002_rooms`：`rooms` / `room_members` / `messages`（房间、成员、历史）
- `003_users_bio`：个性签名
- `004_friends`：`friendships`（好友关系，pending/accepted）
- `005_mentions`：`messages.mentions`（提及快照 JSONB + GIN 索引）
- `006_media`：`media`（图片字节存储）+ `messages.kind/media_url`
- `007_mutes`：`room_mutes`（限时禁言，到期惰性失效）
- `008_recalled`：`messages.recalled`（撤回）
- `009_replies`：`messages.reply_to`（引用回复）
- `010_dm_messages`：`dm_messages`（好友私聊，双向索引）
- `011_edited`：`messages.edited_at` / `dm_messages.edited_at`（消息编辑）
- `012_recalled_by`：`messages.recalled_by`（撤回操作者，房主代撤文案用）
- `013_stickers`：`user_stickers`（个人云表情，跨设备同步）/ `room_stickers`（房间共享表情库，成员贡献）
- `014_invite_links`：`invite_links`（16 位长码，可过期 `expires_at` / 可限次数 `max_uses` / `used_count` 计数，随房间级联删除）
- `015_forwarded_label`：`messages.forwarded_from_label` / `dm_messages.forwarded_from_label`（转发来源展示快照，纯展示不参与权限判断）
- `016_media_urls`：`messages.media_urls` / `dm_messages.media_urls`（多图消息的完整 URL 列表 JSONB，首图仍写 `media_url` 兼容旧客户端）

## 6. 游戏 Overlay（透明置顶窗口方案）

不做 Direct3D/OpenGL 挂钩、不做 DLL 注入。使用 Tauri 原生能力，六个窗口入口（Vite 多页：index / input / overlay / settings / screen / share）：

- **main**：聊天主窗口（React 全量 UI）
- **input**（快捷输入框）：`decorations:false, transparent:true, alwaysOnTop:true, skipTaskbar:true, focus:true`；全局快捷键（默认 `Alt+G`，设置可改；再按一次关闭）呼出 → 定位主屏底部居中 → 聚焦；Enter 发送（emit `game-input-send` → 主窗口走 WS）→ 自动隐藏；Esc 或再次按呼出键取消（emit `game-input-cancel`）。
- **overlay**（消息浮层）：同参数 + `focus:false` + `setIgnoreCursorEvents(true)`（点击穿透）；背景**绝对透明**（CSS `background: transparent`）；位置 6 预设（左上/上中/右上/左下/下中/右下）+ 缩放 0.5–2.0 + 自动隐藏时长 2–15s，设置实时生效（`applyOverlayConfig` → setPosition/setSize + emit config → CSS zoom）。浮层可能比主窗口晚挂载，因此每次推送消息前都会补发一次配置，避免缩放/时长停留在默认值。
- **settings**：独立设置窗口，与主窗口共享 localStorage，变更经 `settings:changed` 事件回流主窗口执行本地副作用（快捷键、浮层位置、代理）。
- **screen-\*** / **share-\***：屏幕共享的观看窗与采集窗，各自持有独立的 WS 信令连接（见第 4 节屏幕共享）。

**焦点恢复**：输入窗发送后隐藏，Windows 将焦点还给先前的前台窗口（即游戏）。**前提**：目标用户在游戏中采用**无边框窗口化**模式（覆盖式窗口在独占全屏下无效）。

## 6.1 主题与提示音

**主题**：`App.css` 顶部一份 `:root` 定义全部设计 token（表面/边框/文本/品牌色/状态色/侧栏/阴影/圆角/动效），`[data-theme='dark']` 只覆盖 token，组件规则不含主题判断。`app/theme.ts` 提供 `applyTheme/applyStoredTheme`，主窗口、设置、观看窗、采集窗各自在启动时调用；设置项 `theme = auto|light|dark`，跟随系统时监听 `prefers-color-scheme` 变化。

**提示音**：`app/audio.ts` 用 WebAudio 合成（零音频资源）。每个音是「正弦主音 + 失谐副音」经 8ms 起音、指数衰减、低通滤波（3.2kHz）后的叠加；四种事件音色——收到消息（E6→A6）、被 @（E6→G#6→C7）、发送确认（D6 极轻）、失败（G5→D5）。音量取自设置 `soundVolume`，共享带音频时由 `setExternalMute(true)` 全局静音（采集窗控制条触发，经 `share:audio-mute` 事件通知主窗口）。

## 7. 断线重连与可靠性

**客户端**（ChatSocket + chat store）：
- 快速退避重连：1s → 1s → 2s → 3s → 5s（封顶 5s），另有 8s 握手超时。
- 应用层心跳：15s 一次 ping；35s 无 pong 判定半开连接，强制重连。
- 发送自愈：消息**真正发出**后 5s 未被确认判定连接假活，强制重连；仍在排队（订阅未就绪）的消息不计入，避免重连刚开就被误判清空队列。
- 订阅看门狗：连接已开但活跃房间未订阅时，每 2s 补发 `room:join`。
- 重连成功后强制重载活跃房间历史，补回断开期间已入库的消息；重载时**合并**拉取期间经 WS 到达的新消息，不会被旧快照覆盖。开着私聊时不会重载房间（避免被拽出私聊）。
- 历史加载失败不标记为「已加载」，重新选中会话会重试；换账号时用世代令牌丢弃在途的旧账号响应。
- 私聊与房间互斥表达活跃会话：打开私聊后，房间消息照常计未读并弹通知；窗口最小化或隐藏到托盘时，当前会话的消息同样计未读并弹通知。

**服务端**：
- SIGINT/SIGTERM 优雅关闭（关 WS、关连接池）；协议层心跳巡检（见第 4 节）。
- 生产健康检查：`GET /health`（含 DB 探活），供容器编排使用。

## 8. 安全

- 密码 argon2 哈希；JWT HS256，`JWT_SECRET` 生产必配（默认值启动即报错）。
- 输入长度/内容校验（消息 ≤2000 字符、房间 id ≤64、用户名 3-24 位白名单、签名 ≤100）；WS 消息类型白名单。
- 入参校验：所有直接进 SQL 的 UUID 先过 `lib/validate.isUuid`，非字符串文本统一归零；PG 错误由全局处理映射为 400/404（见第 4 节错误码语义）。
- 限流：REST 全局每 IP 每分钟 300 次（`RATE_LIMIT_MAX`），注册/登录加严到每分钟 10 次
  （`RATE_LIMIT_AUTH_MAX`，防爆破），WS 单连接每 5s 25 条；超限统一回 `rate_limited`/HTTP 429。
  反代后按 X-Forwarded-For 取真实 IP，但**只信任回环/私有网段来源**的转发头——公网直连客户端伪造的 XFF 会被忽略，不能借此绕过限流。
- WS 加固：单帧 64KB 上限（见第 4 节）；单连接发送缓冲超过 8MB（客户端不读数据）直接断开，防内存积压。
- 邀请码/邀请链接用 `crypto.randomInt` 生成（CSPRNG），不用 `Math.random`。
- 头像：上传 data URL 类型/大小（≤3MB）/魔数三重校验；分发走 `/api/avatars/:id`（公开端点，
  id 为不可枚举 UUID），带 5 分钟缓存头。
- 消息图片：`POST /api/media` 需登录，类型/大小（≤5MB）/魔数三重校验；读取 `/api/media/:id`
  公开（`<img>` 无法附带认证头），id 为不可枚举 UUID + immutable 缓存；发送时校验媒体归属，群表情入库时同样校验归属。
- 注册并发竞态由用户名唯一索引兜底（冲突返回 409）；邀请兑换用「占位入房 + 条件原子自增」防超额，并发下不会 500。
- CORS 可配置：compose 默认 `*`（桌面客户端不受浏览器同源限制），可经 `CORS_ORIGIN` 收紧。
- 无硬编码 secret；`.env.example` 提供模板；忘记密码由服务器主人用 `npm run reset-password` 重置。
