import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { resolveBuildId } from "./scripts/build-id.mjs";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// 本次构建的唯一标识（build.<时间戳>.<短sha>）：注入前端供关于页展示
const buildId = resolveBuildId();

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  define: {
    __BUILD_ID__: JSON.stringify(buildId),
  },

  // 多页面：主窗口 + 输入 Overlay + 消息 Overlay + 设置 + 屏幕共享观看窗
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        input: resolve(__dirname, "input.html"),
        overlay: resolve(__dirname, "overlay.html"),
        settings: resolve(__dirname, "settings.html"),
        screen: resolve(__dirname, "screen.html"),
        share: resolve(__dirname, "share.html"),
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
