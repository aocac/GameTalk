/**
 * 主题：跟随系统 / 浅色 / 深色。
 * 只切换 <html data-theme>，颜色全部由 App.css 顶部的 token 决定；
 * 独立窗口（设置/观看/采集）启动时各自调用 applyStoredTheme() 读同一份设置。
 */

export type ThemeSetting = 'auto' | 'light' | 'dark';

export function resolveTheme(setting: ThemeSetting): 'light' | 'dark' {
  if (setting === 'auto') {
    try {
      return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch {
      return 'light';
    }
  }
  return setting;
}

export function applyTheme(setting: ThemeSetting): void {
  try {
    document.documentElement.dataset.theme = resolveTheme(setting);
  } catch {
    /* 非浏览器环境忽略 */
  }
}

function storedSetting(): ThemeSetting {
  try {
    const raw = localStorage.getItem('gametalk-settings');
    const t = raw ? (JSON.parse(raw)?.state?.theme as ThemeSetting) : 'auto';
    return t === 'light' || t === 'dark' ? t : 'auto';
  } catch {
    return 'auto';
  }
}

/** 启动时应用已保存的主题；跟随系统时监听系统变化实时切换 */
export function applyStoredTheme(): void {
  applyTheme(storedSetting());
  try {
    window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (storedSetting() === 'auto') applyTheme('auto');
    });
  } catch {
    /* 忽略 */
  }
}
