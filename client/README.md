# GameTalk Client

Tauri 2 + React 19 + TypeScript 桌面客户端。Windows 提供全部功能（游戏模式、屏幕采集），Linux / macOS 的聊天与观看功能完整，由 CI 产出对应安装包。

## 窗口

一个进程内六个窗口入口，各自是独立的 webview，通过 Tauri 事件和 localStorage 同源的 zustand store 协作。

| 窗口 | 入口 | 说明 |
|---|---|---|
| `main` | index.html | 聊天主界面（登录 / 房间 / 好友 / 私聊 / 成员面板） |
| `input` | input.html | 游戏内快捷输入框（透明置顶，全局快捷键呼出，Enter 发送 / Esc 取消） |
| `overlay` | overlay.html | 消息浮层（绝对透明、点击穿透、可拖拽定位 / 缩放） |
| `settings` | settings.html | 独立设置窗口（变更经 `settings:changed` 回流主窗口执行副作用） |
| `screen-*` | screen.html | 屏幕共享观看窗（独立系统窗口，自持 WS 信令） |
| `share-*` | share.html | 屏幕采集窗（发起 `getDisplayMedia`，采集后隐藏自身） |

## 常用命令

```bash
npm install
npm run dev          # vite dev server（配合 tauri dev 使用）
npm run tauri dev    # 桌面开发模式（需 Rust + MSVC）
npm test             # vitest：gameMode 单测 + store 回归 + 真实 server 集成（自动构建并拉起 ../server）
npm run lint         # ESLint
npm run build        # 生成构建标识 + tsc + vite build
npm run build:full   # tauri build + 复制安装包到仓库根目录（文件名含构建标识）
```

`npm run build` 会先跑 `scripts/build-id.mjs --fresh` 生成唯一构建标识 `build.<时间戳>.<git 短 sha>`，写入 `client/.build-id` 并注入前端（登录页与设置「关于」页显示）。安装包复制脚本读同一个标识，保证包名与应用内显示一致。

## 结构

- `src/app/`：基础能力（`ws` 客户端 / `api` / `settings` / `gameMode` / `audio` / `screenShare` / `types`）
- `src/stores/`：zustand 状态（`auth` / `chat` / `friends`），token 与设置持久化在 localStorage
- `src/App.tsx`：主界面（登录 / 聊天 / 成员面板 / 各弹窗）
- `src/buildInfo.ts`：构建标识（由 vite `define` 注入）
- `src-tauri/`：Rust 壳（托盘、单实例、quit_app、set_proxy、采集提示条隐藏），业务逻辑尽量留在 TS
- `capabilities/`：Tauri 权限清单，按窗口标签分开授权（main / input+overlay / settings / screen+share）
- `test/`：gameMode 单测、store 回归、真实 server 集成测试

## 开发注意

- `tauri.conf.json` 的 `additionalBrowserArgs` 是共享 WebView2 浏览器进程的全局参数，误用会让 input/overlay 窗口加载失败；代理请走 `set_proxy` 命令（CDP `Network.setProxyOverride`，关闭时下发空规则清除覆盖）。
- Tauri v2 的 `WebviewWindow.getByLabel` 返回 Promise；全局快捷键插件是 `@tauri-apps/plugin-global-shortcut`。
- effect 里的 Tauri API 一律 try/catch：非 Tauri 环境（浏览器调试）会**同步抛异常**，不是 promise 拒绝。
- 调用了新的 window API 就要同步补 `capabilities/*.json` 权限，否则调用会被静默拒绝。
- 给 `src-tauri` 加 Windows 相关 crate 必须放进 `[target.'cfg(windows)'.dependencies]`，否则 Linux CI 的 cargo check 会挂。
- 想用干净配置启动已构建的 release 包（不加载本机真实会话）：`WEBVIEW2_USER_DATA_FOLDER=C:\tmp\gt-profile gametalk.exe`。
