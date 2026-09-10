/// <reference types="vite/client" />

/** 构建唯一标识（由 vite.config.ts 的 define 注入，见 scripts/build-id.mjs） */
declare const __BUILD_ID__: string;

interface ImportMetaEnv {
  /**
   * 构建期注入的默认服务器地址（来自 client/.env.local，见 client/.env.example）。
   * 只在生产构建生效；未注入时回落 FALLBACK_SERVER_URL。
   */
  readonly VITE_DEFAULT_SERVER_URL?: string;
}
