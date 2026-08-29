import { useState } from 'react';
import { emit } from '@tauri-apps/api/event';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useSettings, applyProxySetting, type OverlayPosition } from './app/settings';
import HotkeyRecorder from './components/HotkeyRecorder';
import appIcon from './assets/app-icon.png';
import pkg from '../package.json';

/**
 * 独立设置窗口（settings.html 入口）。
 * 与主窗口共享 localStorage（zustand persist 同源自动恢复）；
 * 每次变更先写自身 store，再 emit settings:changed 让主窗口同步并执行
 * 主窗口侧效果（快捷键注册 / Overlay 定位 / 代理应用）。
 */

const POSITION_LABELS: Record<OverlayPosition, string> = {
  'top-left': '左上',
  'top-center': '顶部居中',
  'top-right': '右上',
  'bottom-left': '左下',
  'bottom-center': '底部居中',
  'bottom-right': '右下',
  custom: '自定义（拖拽）',
};

const REPO_URL = 'https://github.com/aocac/GameTalk';
const RELEASES_URL = `${REPO_URL}/releases/latest`;

/** 变更：写自身 store + 通知主窗口 */
function change(
  key: 'serverUrl' | 'soundEnabled' | 'gameModeEnabled' | 'hotkey' | 'overlayPosition' | 'overlayScale' | 'overlayDurationSec' | 'useProxy' | 'proxyAddress' | 'overlayReset',
  value: unknown,
): void {
  const s = useSettings.getState() as unknown as Record<string, unknown>;
  (s[`set${key[0]!.toUpperCase()}${key.slice(1)}`] as ((v: unknown) => void) | undefined)?.(value);
  void emit('settings:changed', { key, value }).catch(() => undefined);
}

type Section = 'general' | 'game' | 'overlay' | 'about';

export default function SettingsWindow() {
  const [section, setSection] = useState<Section>('general');
  const settings = useSettings();
  const [updateState, setUpdateState] = useState<'idle' | 'checking' | 'latest' | 'newer'>('idle');
  const [latestVersion, setLatestVersion] = useState('');

  const open = (url: string) => {
    void openUrl(url).catch(() => window.open(url, '_blank'));
  };

  const checkUpdate = async () => {
    setUpdateState('checking');
    try {
      const res = await fetch('https://api.github.com/repos/aocac/GameTalk/releases/latest');
      const data = (await res.json()) as { tag_name?: string };
      const tag = String(data.tag_name ?? '');
      const latest = tag.replace(/^v/, '');
      const cur = pkg.version;
      const newer =
        latest !== cur &&
        latest.split('.').some((n, i) => Number(n) > Number(cur.split('.')[i] ?? 0));
      setLatestVersion(latest);
      setUpdateState(newer ? 'newer' : 'latest');
    } catch {
      // 网络失败：退回「打开发布页」自行查看
      setUpdateState('latest');
      setLatestVersion('');
    }
  };

  const navItems: Array<{ key: Section; label: string }> = [
    { key: 'general', label: '通用' },
    { key: 'game', label: '游戏模式' },
    { key: 'overlay', label: '消息悬浮层' },
    { key: 'about', label: '关于 GameTalk' },
  ];

  return (
    <div className="settings-app">
      <aside className="settings-nav">
        <div className="settings-nav-brand">
          <img src={appIcon} alt="GameTalk" draggable={false} />
          <span>设置</span>
        </div>
        {navItems.map((n) => (
          <button key={n.key} type="button" className={`settings-nav-item ${section === n.key ? 'active' : ''}`} onClick={() => setSection(n.key)}>
            {n.label}
          </button>
        ))}
      </aside>

      <main className="settings-content">
        {section === 'general' && (
          <>
            <h3>通用</h3>
            <label className="field">
              <span>服务器地址（修改后需重新连接生效）</span>
              <input
                value={settings.serverUrl}
                placeholder="https://chat.example.com"
                onChange={(e) => change('serverUrl', e.target.value)}
              />
              <span className="field-hint">填写你部署的 GameTalk 服务器地址；本地开发调试可用 http://127.0.0.1:8787</span>
            </label>
            <label className="field">
              <span>消息提示音</span>
              <div className="switch-row">
                <input type="checkbox" checked={settings.soundEnabled} onChange={(e) => change('soundEnabled', e.target.checked)} />
                {settings.soundEnabled ? '已开启' : '已关闭'}
              </div>
            </label>
            <div className="settings-section">
              <span className="section-title">网络代理</span>
              <label className="field">
                <span>启用代理（默认关闭 = 直连，不走系统代理）</span>
                <div className="switch-row">
                  <input
                    type="checkbox"
                    checked={settings.useProxy}
                    onChange={(e) => {
                      change('useProxy', e.target.checked);
                      void applyProxySetting(e.target.checked, settings.proxyAddress);
                    }}
                  />
                  {settings.useProxy ? '已启用' : '已关闭'}
                </div>
              </label>
              {settings.useProxy && (
                <label className="field">
                  <span>代理地址（HTTP 混合代理，如 127.0.0.1:7890）</span>
                  <input
                    value={settings.proxyAddress}
                    placeholder="127.0.0.1:7890"
                    onChange={(e) => {
                      change('proxyAddress', e.target.value);
                      void applyProxySetting(true, e.target.value);
                    }}
                  />
                </label>
              )}
              <span className="field-hint">连接国内/自建服务器建议保持关闭（直连最快）；仅当服务器需要经代理访问时再开启。</span>
            </div>
          </>
        )}

        {section === 'game' && (
          <>
            <h3>游戏模式</h3>
            <label className="field">
              <span>启用游戏模式（全局快捷键 + 消息悬浮层）</span>
              <div className="switch-row">
                <input type="checkbox" checked={settings.gameModeEnabled} onChange={(e) => change('gameModeEnabled', e.target.checked)} />
                {settings.gameModeEnabled ? '已启用' : '已停用'}
              </div>
            </label>
            <label className="field">
              <span>呼出快捷键（点击后按下组合键；游戏中再按一次可关闭输入框）</span>
              <HotkeyRecorder value={settings.hotkey} onChange={(v) => change('hotkey', v)} />
            </label>
            <span className="field-hint">建议使用单 Alt 组合键（如 Alt+G）；避免使用 Space 等游戏内常用按键。</span>
          </>
        )}

        {section === 'overlay' && (
          <>
            <h3>消息悬浮层</h3>
            <div className="field">
              <span>显示位置（点击即应用并预览 5 秒）</span>
              <div className="position-chips">
                {(Object.keys(POSITION_LABELS) as OverlayPosition[]).map((v) => (
                  <button
                    key={v}
                    type="button"
                    className={`chip ${v === settings.overlayPosition ? 'active' : ''}`}
                    onClick={() => {
                      if (v === 'custom') {
                        // 自定义 = 进入拖拽调整（主窗口侧接管，overlay 窗口内拖动）
                        void emit('settings:adjust-overlay', { active: true });
                      } else {
                        change('overlayPosition', v);
                      }
                    }}
                  >
                    {POSITION_LABELS[v]}
                  </button>
                ))}
              </div>
              <span className="position-current">当前位置：{POSITION_LABELS[settings.overlayPosition]}</span>
            </div>
            {settings.overlayPosition === 'custom' && (
              <div className="row-between">
                <button className="btn ghost small" onClick={() => void emit('settings:adjust-overlay', { active: true })}>
                  重新拖拽调整
                </button>
                <button className="btn ghost small" onClick={() => void emit('settings:adjust-overlay', { active: false })}>
                  结束调整
                </button>
                <button className="btn ghost small" onClick={() => change('overlayReset', true)}>
                  复位到左上角
                </button>
              </div>
            )}
            <label className="field">
              <span>缩放比例：{Math.round(settings.overlayScale * 100)}%</span>
              <input
                type="range"
                min={0.5}
                max={2}
                step={0.1}
                value={settings.overlayScale}
                onChange={(e) => change('overlayScale', parseFloat(e.target.value))}
              />
            </label>
            <label className="field">
              <span>显示时长：{settings.overlayDurationSec} 秒</span>
              <input
                type="range"
                min={2}
                max={15}
                step={1}
                value={settings.overlayDurationSec}
                onChange={(e) => change('overlayDurationSec', parseInt(e.target.value, 10))}
              />
            </label>
          </>
        )}

        {section === 'about' && (
          <>
            <h3>关于 GameTalk</h3>
            <div className="about-hero">
              <img src={appIcon} alt="GameTalk" draggable={false} />
              <div>
                <div className="about-name">GameTalk</div>
                <div className="about-version">版本 v{pkg.version}</div>
              </div>
            </div>
            <div className="about-rows">
              <div className="about-row">
                <span>仓库地址</span>
                <button className="about-link" onClick={() => open(REPO_URL)}>
                  {REPO_URL}
                </button>
              </div>
              <div className="about-row">
                <span>开源协议</span>
                <button className="about-link" onClick={() => open(`${REPO_URL}/blob/main/LICENSE`)}>
                  MIT License
                </button>
              </div>
              <div className="about-row">
                <span>检查更新</span>
                <div className="about-update">
                  {updateState === 'idle' && (
                    <button className="btn primary small" onClick={() => void checkUpdate()}>
                      检查更新
                    </button>
                  )}
                  {updateState === 'checking' && <span className="about-hint">检查中…</span>}
                  {updateState === 'latest' && <span className="about-hint">已是最新版本 ✓</span>}
                  {updateState === 'newer' && (
                    <>
                      <span className="about-new">发现新版本 v{latestVersion}</span>
                      <button className="btn primary small" onClick={() => open(RELEASES_URL)}>
                        前往下载
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
            <p className="about-foot">为 PC 玩家打造的轻量级游戏内群组通信工具。</p>
          </>
        )}
      </main>
    </div>
  );
}
