# GameTalk Client

Tauri 2 + React 19 + TypeScript 桌面客户端（Windows 为主，Linux/macOS 由 CI 产出构建）。

## 三窗口架构

| 窗口 | 入口 | 说明 |
|---|---|---|
| `main` | index.html | 聊天主界面（登录/房间/设置） |
| `input` | input.html | 游戏内输入框（透明置顶，全局快捷键呼出，Enter 发送 / Esc 取消） |
| `overlay` | overlay.html | 消息悬浮层（绝对透明、点击穿透、可拖拽定位/缩放） |

## 常用命令

```bash
npm install
npm run dev          # vite dev server（配合 tauri dev 使用）
npm run tauri dev    # 桌面开发模式（需 Rust + MSVC）
npm test             # vitest：gameMode 单测 + 真实 server 集成测试（自动构建并拉起 ../server）
npm run build        # tsc + vite build（前端产物）
npm run build:full   # tauri build + 复制安装包到仓库根目录
```

## 结构

- `src/app/`：基础能力（ws 客户端 / api / settings / gameMode / audio / types）
- `src/stores/`：zustand 状态（auth / chat，localStorage 持久化 token 与设置）
- `src/App.tsx`：主界面（登录 / 聊天 / 设置 / 关闭确认）
- `src-tauri/`：Rust 壳（托盘、单实例、quit_app、set_proxy），逻辑尽量不进 Rust
- `capabilities/`：Tauri 权限清单（main 与 input/overlay 分开授权）

## 注意事项（历史坑位）

- `tauri.conf.json` 的 `additionalBrowserArgs` 是共享 WebView2 浏览器进程的全局参数，
  误用会让 input/overlay 窗口加载失败——代理请走 `set_proxy` 命令（CDP setProxyOverride）。
- Tauri v2 的 `WebviewWindow.getByLabel` 返回 Promise；全局快捷键插件是
  `@tauri-apps/plugin-global-shortcut`。
