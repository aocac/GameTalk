import { describe, it, expect } from 'vitest';
import { DEFAULT_SERVER_URL, FALLBACK_SERVER_URL, resolveDefaultServerUrl } from '../src/app/settings';

describe('默认服务器地址解析', () => {
  it('未注入（空串）时回落本地开发地址', () => {
    expect(resolveDefaultServerUrl('')).toBe(FALLBACK_SERVER_URL);
  });

  it('注入值为纯空白时同样回落', () => {
    expect(resolveDefaultServerUrl('   \n\t ')).toBe(FALLBACK_SERVER_URL);
  });

  it('注入自定义地址时原样采用', () => {
    expect(resolveDefaultServerUrl('https://chat.example.com')).toBe('https://chat.example.com');
  });

  it('去掉首尾空白与尾部斜杠（多根斜杠一并去掉）', () => {
    expect(resolveDefaultServerUrl('  https://chat.example.com///  ')).toBe('https://chat.example.com');
    expect(resolveDefaultServerUrl('https://chat.example.com/')).toBe('https://chat.example.com');
  });

  it('保留带端口与路径前缀的地址', () => {
    expect(resolveDefaultServerUrl('https://chat.example.com:8443')).toBe('https://chat.example.com:8443');
  });

  /**
   * 关键回归：单测与 `vite dev` 走的是非生产分支，即使开发机上存在 client/.env.local
   * 也不得把默认地址变成生产域名（否则本地测试会连线上）。
   */
  it('测试/开发环境不受 .env.local 注入影响，DEFAULT_SERVER_URL 恒为本地地址', () => {
    expect(DEFAULT_SERVER_URL).toBe(FALLBACK_SERVER_URL);
  });
});
