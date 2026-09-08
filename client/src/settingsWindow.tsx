import { useEffect, useState } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useSettings, applyProxySetting, type OverlayPosition } from './app/settings';
import { QUALITY_OPTIONS, QUALITY_PRESETS, qualityLabel } from './app/screenShare';
import { previewSound } from './app/audio';
import { applyTheme } from './app/theme';
import HotkeyRecorder from './components/HotkeyRecorder';
import appIcon from './assets/app-icon.png';
import { BUILD_ID } from './buildInfo';
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
  key:
    | 'serverUrl'
    | 'soundEnabled'
    | 'gameModeEnabled'
    | 'hotkey'
    | 'overlayPosition'
    | 'overlayScale'
    | 'overlayDurationSec'
    | 'useProxy'
    | 'proxyAddress'
    | 'notifyLevel'
    | 'soundVolume'
    | 'overlayEnabled'
    | 'overlayReset'
    | 'shareQuality'
    | 'shareBudgetMbps'
    | 'shareMuteOwnSounds'
    | 'theme',
  value: unknown,
): void {
  const s = useSettings.getState() as unknown as Record<string, unknown>;
  (s[`set${key[0]!.toUpperCase()}${key.slice(1)}`] as ((v: unknown) => void) | undefined)?.(value);
  void emit('settings:changed', { key, value }).catch(() => undefined);
}

type Section = 'general' | 'notify' | 'game' | 'overlay' | 'screen' | 'about';

/** 初始分类：主窗口打开时可用 ?section= 指定 */
const VALID_SECTIONS: Section[] = ['general', 'notify', 'game', 'overlay', 'screen', 'about'];

function initialSection(): Section {
  const q = new URLSearchParams(window.location.search).get('section');
  return VALID_SECTIONS.includes(q as Section) ? (q as Section) : 'general';
}

export default function SettingsWindow() {
  const [section, setSection] = useState<Section>(initialSection);
  const settings = useSettings();
  const [updateState, setUpdateState] = useState<'idle' | 'checking' | 'latest' | 'newer' | 'dev-newer'>('idle');
  const [updateError, setUpdateError] = useState(false);
  const [latestVersion, setLatestVersion] = useState('');

  const open = (url: string) => {
    void openUrl(url).catch(() => window.open(url, '_blank'));
  };

  const checkUpdate = async () => {
    setUpdateState('checking');
    setUpdateError(false);
    try {
      // GitHub 访问受限/挂起时不能让「检查中…」永远挂着
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      let res: Response;
      try {
        res = await fetch('https://api.github.com/repos/aocac/GameTalk/releases/latest', { signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      const data = (await res.json()) as { tag_name?: string };
      const latest = String(data.tag_name ?? '').replace(/^v/, '');
      if (!latest) throw new Error('no release');
      const cur = pkg.version.split('.').map(Number);
      const rel = latest.split('.').map(Number);
      // 逐段比较：发布版更高=有更新；当前更高=本地为未发布的新版本
      let cmp = 0;
      for (let i = 0; i < 3; i++) {
        if ((rel[i] ?? 0) !== (cur[i] ?? 0)) {
          cmp = (rel[i] ?? 0) > (cur[i] ?? 0) ? 1 : -1;
          break;
        }
      }
      setLatestVersion(latest);
      setUpdateState(cmp > 0 ? 'newer' : cmp < 0 ? 'dev-newer' : 'latest');
    } catch {
      // 网络失败：如实提示失败可重试，不误报「已是最新」
      setUpdateError(true);
      setUpdateState('idle');
    }
  };

  const navItems: Array<{ key: Section; label: string }> = [
    { key: 'general', label: '通用' },
    { key: 'notify', label: '通知' },
    { key: 'game', label: '游戏模式' },
    { key: 'overlay', label: '屏幕覆盖' },
    { key: 'screen', label: '屏幕共享' },
    { key: 'about', label: '关于 GameTalk' },
  ];

  // 主窗口对已打开的设置窗口发起分类跳转（如点状态栏「提示音」时窗口已存在）
  useEffect(() => {
    void listen<{ section?: Section }>('settings:navigate', (e) => {
      const s = e.payload?.section;
      if (s && VALID_SECTIONS.includes(s)) setSection(s);
    }).catch(() => undefined);
  }, []);

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
            <div className="field">
              <span>界面主题</span>
              <div className="chip-row">
                {(['auto', 'light', 'dark'] as const).map((t) => (
                  <button
                    key={t}
                    className={`chip ${settings.theme === t ? 'active' : ''}`}
                    onClick={() => {
                      change('theme', t);
                      applyTheme(t);
                    }}
                  >
                    {t === 'auto' ? '跟随系统' : t === 'light' ? '浅色' : '深色'}
                  </button>
                ))}
              </div>
            </div>
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
            <div className="settings-section">
              <span className="section-title">网络代理</span>
              <label className="field">
                <span>启用代理（默认关闭 = 跟随系统代理）</span>
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
              <span className="field-hint">连接国内/自建服务器建议保持关闭（跟随系统代理）；仅当服务器需要经指定代理访问时再开启。</span>
            </div>
          </>
        )}

        {section === 'notify' && (
          <>
            <h3>通知</h3>
            <div className="field">
              <span>Windows 系统通知程度</span>
              <div className="position-chips">
                {([
                  ['all', '全部消息'],
                  ['mention', '仅 @我 和私聊'],
                  ['none', '不弹通知'],
                ] as Array<[string, string]>).map(([v, label]) => (
                  <button
                    key={v}
                    type="button"
                    className={`chip ${settings.notifyLevel === v ? 'active' : ''}`}
                    onClick={() => change('notifyLevel', v)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <span className="field-hint">当前正打开的会话不弹系统通知（消息就在眼前）；游戏内的消息悬浮层不受此设置影响。</span>
            </div>
            <label className="field">
              <span>消息提示音</span>
              <div className="switch-row">
                <input type="checkbox" checked={settings.soundEnabled} onChange={(e) => change('soundEnabled', e.target.checked)} />
                {settings.soundEnabled ? '已开启' : '已关闭'}
              </div>
            </label>
            <label className="field">
              <span>音量：{settings.soundVolume}%</span>
              <input
                type="range"
                min={0}
                max={100}
                value={settings.soundVolume}
                disabled={!settings.soundEnabled}
                onChange={(e) => change('soundVolume', Number(e.target.value))}
              />
            </label>
            <div className="field">
              <span>试听</span>
              <div className="chip-row">
                <button className="chip" disabled={!settings.soundEnabled} onClick={() => previewSound('message')}>
                  收到消息
                </button>
                <button className="chip" disabled={!settings.soundEnabled} onClick={() => previewSound('mention')}>
                  被 @
                </button>
                <button className="chip" disabled={!settings.soundEnabled} onClick={() => previewSound('send')}>
                  发送确认
                </button>
                <button className="chip" disabled={!settings.soundEnabled} onClick={() => previewSound('error')}>
                  失败提示
                </button>
              </div>
            </div>
          </>
        )}

        {section === 'screen' && (
          <>
            <h3>屏幕共享</h3>
            <div className="field">
              <span>画质档位（共享中也能在右下角控制条上随时切换）</span>
              <div className="chip-row">
                {QUALITY_OPTIONS.map((q) => (
                  <button
                    key={q}
                    className={`chip ${settings.shareQuality === q ? 'active' : ''}`}
                    title={q === 'auto' ? '按观看人数与带宽预算自动选档' : `单路上限 ${(QUALITY_PRESETS[q].maxBitrate / 1_000_000).toFixed(1)}Mbps`}
                    onClick={() => change('shareQuality', q)}
                  >
                    {qualityLabel(q)}
                  </button>
                ))}
              </div>
              <span className="field-hint">
                自动＝按观看人数和上行预算选档（1 人清晰、2–4 人流畅、更多人省流量），并在实测丢包/延迟变差时自动降码率；也可以手动锁定某一档。清晰优先＝保分辨率、带宽不足时掉帧；流畅优先＝保帧率、带宽不足时降分辨率；省流量＝低码率并主动降分辨率。
              </span>
            </div>
            <label className="field">
              <span>上行总带宽预算（Mbps）</span>
              <input
                type="number"
                min={2}
                max={50}
                value={settings.shareBudgetMbps}
                onChange={(e) => change('shareBudgetMbps', Number(e.target.value))}
              />
              <span className="field-hint">
                按观看人数分摊：2 人观看时每路各占一半，人多时每路自动降低但有下限（约 1.2Mbps）。家用宽带上传通常 20–50Mbps，共享给 3 人建议不超过 12。
              </span>
            </label>
            <label className="field">
              <span>共享系统声音时，静音本应用提示音</span>
              <div className="switch-row">
                <input
                  type="checkbox"
                  checked={settings.shareMuteOwnSounds}
                  onChange={(e) => change('shareMuteOwnSounds', e.target.checked)}
                />
                {settings.shareMuteOwnSounds ? '已开启' : '已关闭'}
              </div>
              <span className="field-hint">WebView2 无法做进程级音频隔离，开启后共享期间你听不到自己的提示音，但对方也不会被它吵到。</span>
            </label>
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
          </>
        )}

        {section === 'overlay' && (
          <>
            <h3>屏幕覆盖</h3>
            <label className="field">
              <span>启用屏幕覆盖（游戏中实时叠加显示新消息）</span>
              <div className="switch-row">
                <input type="checkbox" checked={settings.overlayEnabled} onChange={(e) => change('overlayEnabled', e.target.checked)} />
                {settings.overlayEnabled ? '已开启' : '已关闭'}
              </div>
            </label>
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
                        // 自定义：切换高亮到自定义（持久化），并进入拖拽调整（主窗口侧接管）
                        change('overlayPosition', 'custom');
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
              <span className="field-hint">已进入自定义模式：直接拖动屏幕上的悬浮层调整位置，收到新消息或超时后自动保存退出。</span>
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
                <div className="about-build" title="每次构建唯一，用于区分同名版本的不同包">
                  {BUILD_ID}
                </div>
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
                    <>
                      <button className="btn primary small" onClick={() => void checkUpdate()}>
                        {updateError ? '重试' : '检查更新'}
                      </button>
                      {updateError && (
                        <>
                          <span className="about-hint err">检查失败（GitHub 访问可能受限）</span>
                          <button className="about-link" onClick={() => open(RELEASES_URL)}>
                            打开发布页手动查看
                          </button>
                        </>
                      )}
                    </>
                  )}
                  {updateState === 'checking' && <span className="about-hint">检查中…</span>}
                  {updateState === 'latest' && <span className="about-hint">已是最新版本 ✓</span>}
                  {updateState === 'dev-newer' && (
                    <span className="about-hint">当前版本 v{pkg.version} 领先最新发布（v{latestVersion}），更新功能尚未发版</span>
                  )}
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
