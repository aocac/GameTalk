/** 构建标识（vite define 注入；vitest/非 vite 环境下回落为 'dev'） */
export const BUILD_ID: string = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev';
