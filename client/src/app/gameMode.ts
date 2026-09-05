import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event';
import { PhysicalPosition, PhysicalSize } from '@tauri-apps/api/dpi';
import { primaryMonitor } from '@tauri-apps/api/window';
import { isRegistered, register, unregister } from '@tauri-apps/plugin-global-shortcut';
import {
  OVERLAY_BASE_HEIGHT,
  OVERLAY_BASE_WIDTH,
  useSettings,
  type OverlayPosition,
} from './settings';
import type { ChatMessage } from './types';


/**
 * 游戏模式管理器（Phase 5）：
 * - 全局快捷键呼出输入 Overlay（透明置顶无边框窗口）
 * - 消息 Overlay：绝对透明背景 + IgnoreCursorEvents + 自定义位置/缩放/自动隐藏
 * - Enter 发送 / Esc 取消：由 input 窗口发事件给主窗口，主窗口走现有 WS 通道
 * - 发送后隐藏输入窗口（Windows 通常将焦点还给先前的前台窗口，即游戏）
 */

export const INPUT_WINDOW_LABEL = 'input';
export const OVERLAY_WINDOW_LABEL = 'overlay';
const INPUT_WIDTH = 460;
const INPUT_HEIGHT = 64;
const INPUT_BOTTOM_MARGIN = 48;
const OVERLAY_MARGIN = 20;


type SendHandler = (text: string) => void;
/** 快捷输入框目标上下文：current=当前目标，targets=全部可切换目标（房间 ∪ 好友私聊） */
export interface InputTarget {
  kind: 'room' | 'dm';
  id: string;
  name: string;
}
export interface InputTargetContext {
  current: InputTarget | null;
  targets: InputTarget[];
}
type TargetProvider = () => InputTargetContext;

let started = false;
let onSend: SendHandler = () => undefined;
let targetProvider: TargetProvider = () => ({ current: null, targets: [] });
const unlisteners: UnlistenFn[] = [];

export function setOnSend(handler: SendHandler): void {
  onSend = handler;
}

export function setInputTargetProvider(provider: TargetProvider): void {
  targetProvider = provider;
}

/** 呼出输入框时的回调（主窗口重置独立目标为当前会话的默认值） */
type InputShownHandler = () => void;
let onInputShown: InputShownHandler = () => undefined;

export function setOnInputShown(handler: InputShownHandler): void {
  onInputShown = handler;
}

/** 把目标上下文下发给 input 窗口（呼出时读 provider；切换后由主窗口直接回发） */
export async function pushInputTargetContext(): Promise<void> {
  await emit('game-input-context', targetProvider());
}

/** 直接下发目标上下文（切换后立即回发，不等异步的会话切换完成） */
export async function emitInputTarget(context: InputTargetContext): Promise<void> {
  await emit('game-input-context', context);
}

function getInputWindow(): Promise<WebviewWindow | null> {
  return WebviewWindow.getByLabel(INPUT_WINDOW_LABEL);
}

function getOverlayWindow(): Promise<WebviewWindow | null> {
  return WebviewWindow.getByLabel(OVERLAY_WINDOW_LABEL);
}

/**
 * 确保 Overlay 窗口存在（webview 崩溃/窗口被意外关闭时重建）。
 * Overlay 平时隐藏，若窗口丢失则消息/预览事件会无人接收——这是"Overlay 完全失效"的兜底。
 */
async function ensureOverlayWindow(): Promise<void> {
  const win = await WebviewWindow.getByLabel(OVERLAY_WINDOW_LABEL);
  if (win) return;
  try {
    new WebviewWindow(OVERLAY_WINDOW_LABEL, {
      title: 'GameTalk 消息',
      url: 'overlay.html',
      width: 380,
      height: 180,
      decorations: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      shadow: false,
      focus: false,
      visible: false,
    });
    // 等窗口与监听器就绪（事件监听在 overlay.tsx mount 时注册）
    await new Promise((r) => setTimeout(r, 500));
  } catch {
    // 重建失败不阻塞主流程
  }
}

export function isGameModeRunning(): boolean {
  return started;
}

/**
 * 确保输入窗口存在（webview 崩溃/窗口被意外关闭时重建）——否则全局快捷键会静默失效。
 */
async function ensureInputWindow(): Promise<void> {
  const win = await WebviewWindow.getByLabel(INPUT_WINDOW_LABEL);
  if (win) return;
  try {
    new WebviewWindow(INPUT_WINDOW_LABEL, {
      title: 'GameTalk 输入',
      url: 'input.html',
      width: INPUT_WIDTH,
      height: INPUT_HEIGHT,
      decorations: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      shadow: false,
      focus: true,
      visible: false,
    });
    await new Promise((r) => setTimeout(r, 500));
  } catch {
    // 重建失败不阻塞主流程
  }
}

function computePosition(
  mon: { position: { x: number; y: number }; size: { width: number; height: number } },
  w: number,
  h: number,
  pos: OverlayPosition,
  margin: number,
): PhysicalPosition {
  const x0 = mon.position.x;
  const y0 = mon.position.y;
  // 关键：居中预设的 x = (屏宽 - 窗宽) / 2 可能是小数（如 1492.5），
  // 传给 Tauri setPosition 会导致窗口应用失败、preview 链中断。
  // 所有坐标统一取整后再返回。
  const r = (x: number, y: number) => new PhysicalPosition(Math.round(x), Math.round(y));
  switch (pos) {
    case 'top-left':
      return r(x0 + margin, y0 + margin);
    case 'top-center':
      return r(x0 + (mon.size.width - w) / 2, y0 + margin);
    case 'top-right':
      return r(x0 + mon.size.width - w - margin, y0 + margin);
    case 'bottom-left':
      return r(x0 + margin, y0 + mon.size.height - h - margin);
    case 'bottom-center':
      return r(x0 + (mon.size.width - w) / 2, y0 + mon.size.height - h - margin);
    case 'bottom-right':
      return r(x0 + mon.size.width - w - margin, y0 + mon.size.height - h - margin);
    case 'custom':
      // 自定义位置走单独分支（applyOverlayConfig 已处理），此处兜底为左下
      return r(x0 + margin, y0 + mon.size.height - h - margin);
  }
}

/** 坐标夹取：确保窗口留在主屏可视范围内（防止拖出屏幕外导致"找不到"） */
function clampToMonitor(
  x: number,
  y: number,
  winW: number,
  winH: number,
  mon: { position: { x: number; y: number }; size: { width: number; height: number } },
): { x: number; y: number } {
  const x0 = mon.position.x;
  const y0 = mon.position.y;
  return {
    x: Math.min(Math.max(x, x0), x0 + Math.max(mon.size.width - winW, 0)),
    y: Math.min(Math.max(y, y0), y0 + Math.max(mon.size.height - winH, 0)),
  };
}

/** 根据设置把消息 Overlay 摆到指定位置并按比例缩放。
 *  positionOverride：显式指定本次要应用的预设（不依赖 store 读取，
 *  避免 select 选择后 store 未及时同步导致应用了旧位置）
 *  opts.move=false：只同步窗口尺寸，不移动窗口（进入拖拽调整时使用，
 *  从当前位置开始拖——绝不跳到已保存的自定义坐标） */
export async function applyOverlayConfig(
  positionOverride?: OverlayPosition,
  opts?: { move?: boolean },
): Promise<void> {
  // 屏幕覆盖关闭：跳过窗口尺寸/位置操作（不创建窗口），仅仍派发配置事件
  if (!useSettings.getState().overlayEnabled) {
    const { overlayScale, overlayDurationSec } = useSettings.getState();
    await emit('overlay:config', { scale: overlayScale, durationSec: overlayDurationSec });
    return;
  }
  const { overlayPosition: storedPosition, overlayScale, overlayCustomPosition, overlayDurationSec } =
    useSettings.getState();
  const overlayPosition = positionOverride ?? storedPosition;
  const win = await getOverlayWindow();
  const mon = await primaryMonitor();
  if (!win || !mon) return;
  const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
  const w = Math.round(OVERLAY_BASE_WIDTH * overlayScale);
  const h = Math.round(OVERLAY_BASE_HEIGHT * overlayScale);
  const winW = Math.round(w * dpr);
  const winH = Math.round(h * dpr);
  try {
    await win.setSize(new PhysicalSize(winW, winH));
    if (opts?.move === false) {
      // 进入拖拽调整：仅同步尺寸，保持当前位置（不跳位）
    } else if (overlayPosition === 'custom' && overlayCustomPosition) {
      // 用户拖拽自定义位置（物理像素，左上角锚点）；越界则夹回屏幕内
      const clamped = clampToMonitor(overlayCustomPosition.x, overlayCustomPosition.y, winW, winH, mon);
      await win.setPosition(new PhysicalPosition(Math.round(clamped.x), Math.round(clamped.y)));
    } else if (overlayPosition === 'custom') {
      // 「自定义」但尚未保存过坐标：保持当前位置不动（只改大小），
      // 等待用户进入拖拽调整——绝不擅自把窗口挪走
    } else {
      const p = computePosition(mon, winW, winH, overlayPosition, OVERLAY_MARGIN * dpr);
      // 所有预设都夹取到主屏内：即使坐标计算异常，窗口也保证可见（最多贴边）
      const clamped = clampToMonitor(p.x, p.y, winW, winH, mon);
      await win.setPosition(new PhysicalPosition(Math.round(clamped.x), Math.round(clamped.y)));
    }
  } catch (e) {
    // 窗口操作失败不应中断 preview 链：记录后继续发事件，
    // 否则 setPosition 异常会导致 applyAndPreview 的 .then(preview) 永不执行
    console.error('applyOverlayConfig window op failed:', e);
  }
  await emit('overlay:config', { scale: overlayScale, durationSec: overlayDurationSec });
}

/** 位置预览：通知 Overlay 显示 5 秒确认位置/大小效果。
 *  注意：show 由 overlay 窗口自身的 preview 监听执行（与 adjust 退出的 hide
 *  同源同序），这里只发事件——跨 webview 直接 show 会与 hide 竞态导致窗口被隐藏 */
export async function previewOverlay(): Promise<void> {
  // 屏幕覆盖关闭：不显示
  if (!useSettings.getState().overlayEnabled) return;
  await ensureOverlayWindow();
  await emit('overlay:preview');
}

/** 进入 Overlay 调整模式：可拖拽移动 + 滚轮缩放（overlay 窗口内操作） */
export async function startOverlayAdjust(): Promise<void> {
  if (!useSettings.getState().overlayEnabled) return;
  await emit('overlay:adjust', { active: true });
}

/** 退出 Overlay 调整模式 */
export async function stopOverlayAdjust(): Promise<void> {
  await emit('overlay:adjust', { active: false });
}

/** 呼出输入框（全局快捷键触发）：定位底部居中 + 显示 + 聚焦 */
export async function showInputWindow(): Promise<void> {
  await registerEsc();
  await ensureInputWindow();
  const win = await getInputWindow();
  const mon = await primaryMonitor();
  if (!win || !mon) {
    return;
  }
  const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
  const x = mon.position.x + (mon.size.width - INPUT_WIDTH * dpr) / 2;
  const y = mon.position.y + mon.size.height - INPUT_HEIGHT * dpr - INPUT_BOTTOM_MARGIN * dpr;
  await win.setPosition(new PhysicalPosition(Math.round(x), Math.round(y)));
  await win.show();
  inputVisible = true;
  // 每次呼出：独立目标重置为默认（主窗口当前会话），再下发上下文
  onInputShown();
  await pushInputTargetContext().catch(() => undefined);
  // Windows 上 show 后需要一点时间才能聚焦
  setTimeout(() => void win.setFocus(), 60);
}

export async function hideInputWindow(): Promise<void> {
  const win = await getInputWindow();
  await unregisterEsc();
  inputVisible = false;
  if (!win) return;
  await win.hide();
}

/** 输入框当前是否显示（呼出快捷键反呼出判定用；所有显隐都经过上面两个函数，状态不会漂移） */
let inputVisible = false;

// ===== 全局 ESC（输入框显示期间生效，隐藏后立即注销，不干扰游戏内 ESC）=====
// 注册/注销必须串行执行，否则快速连续呼出时 register/unregister 竞态
// 会导致 ESC 注册失败而失效（用户反馈：第二次呼出后 ESC 失灵）。
let escRegistered = false;
let escQueue: Promise<void> = Promise.resolve();

function queueEscOp(fn: () => Promise<void>): Promise<void> {
  escQueue = escQueue.then(fn, fn);
  return escQueue;
}

async function registerEsc(): Promise<void> {
  if (escRegistered) return;
  await queueEscOp(async () => {
    if (escRegistered) return;
    try {
      // 先清理可能残留的注册，再注册（避免 already-registered 失败）
      if (await isRegistered('Esc')) await unregister('Esc');
      await register('Esc', () => {
        void hideInputWindow();
      });
      escRegistered = true;
    } catch (e) {
      console.error('register Esc failed:', e);
    }
  });
}

async function unregisterEsc(): Promise<void> {
  if (!escRegistered) return;
  await queueEscOp(async () => {
    if (!escRegistered) return;
    escRegistered = false;
    try {
      await unregister('Esc');
    } catch {
      // 忽略注销失败
    }
  });
}

/** 新消息到达时推给 Overlay 显示（由 chat store 调用）；roomName 标注来源房间，isSelf 标记自己发送 */
export async function pushOverlayMessage(message: ChatMessage, roomName?: string, isSelf?: boolean): Promise<void> {
  // 屏幕覆盖关闭：不显示、不创建窗口
  if (!useSettings.getState().overlayEnabled) return;
  if (!started) {
    return;
  }
  const win = await getOverlayWindow();
  if (!win) {
    // Overlay 窗口丢失（重启后首次使用等）→ 重建，并先应用已保存的位置/缩放配置
    // （新建窗口落在系统默认位置；启动时的 applyOverlayConfig 因窗口不存在而是空操作）
    await ensureOverlayWindow();
    const w2 = await getOverlayWindow();
    if (!w2) {
      return;
    }
    await applyOverlayConfig();
  }
  await emit('overlay:append', { ...message, roomName, isSelf });
}

/** 消息编辑同步到正在显示的 Overlay（items 里没有该消息时无副作用） */
export async function pushOverlayEdit(messageId: string, text: string): Promise<void> {
  if (!useSettings.getState().overlayEnabled || !started) return;
  await emit('overlay:edit', { messageId, text });
}

/** 消息撤回同步到正在显示的 Overlay：直接移除该条 */
export async function pushOverlayRecall(messageId: string): Promise<void> {
  if (!useSettings.getState().overlayEnabled || !started) return;
  await emit('overlay:recalled', { messageId });
}

/** 当前实际注册的呼出快捷键（换键后注销旧键用——否则旧键依旧全局生效） */
let registeredHotkey: string | null = null;

async function registerHotkey(): Promise<void> {
  const { hotkey } = useSettings.getState();
  try {
    // 换键场景：先注销上一个快捷键（真机反馈：设置新快捷键后旧键仍可呼出）
    if (registeredHotkey && registeredHotkey !== hotkey) {
      try {
        if (await isRegistered(registeredHotkey)) await unregister(registeredHotkey);
      } catch {
        // 旧键注销失败不阻塞新键注册
      }
      registeredHotkey = null;
    }
    if (await isRegistered(hotkey)) await unregister(hotkey);
    await register(hotkey, (event) => {
      if (event.state === 'Pressed') {
        // 再按一次呼出键 = 关闭输入框（与 ESC 关闭不冲突）
        void (inputVisible ? hideInputWindow() : showInputWindow());
      }
    });
    registeredHotkey = hotkey;
  } catch (e) {
    console.error('register hotkey failed:', e);
  }
}

/** 快捷键变更后重新注册（游戏模式运行中时由设置界面调用） */
export async function reapplyHotkey(): Promise<void> {
  if (!started) return;
  await registerHotkey();
}

let startGen = 0;

export async function startGameMode(): Promise<void> {
  if (started) return;
  started = true;
  // 世代令牌：StrictMode 双挂载/快速开关时，上一次 start 的 await 间隙里 stop 可能已清空
  // unlisteners——晚到的 listen 句柄必须自检世代，否则孤儿监听会让消息发送两次
  const gen = ++startGen;
  await registerHotkey();
  if (gen !== startGen || !started) return;
  const off1 = await listen('game-input-send', (e) => {
    const text = String(e.payload ?? '').trim();
    if (text) onSend(text);
    void hideInputWindow();
  });
  if (gen !== startGen || !started) {
    off1();
    return;
  }
  unlisteners.push(off1);
  const off2 = await listen('game-input-cancel', () => {
    void hideInputWindow();
  });
  if (gen !== startGen || !started) {
    off1();
    off2();
    return;
  }
  unlisteners.push(off2);
  // Overlay 调整完成：保存自定义位置/缩放并应用
  const off3 = await listen('overlay:adjust-done', (e) => {
    const p = (e.payload ?? {}) as { position?: { x: number; y: number }; scale?: number };
    if (p.position) useSettings.getState().setOverlayCustomPosition(p.position);
    if (typeof p.scale === 'number') useSettings.getState().setOverlayScale(p.scale);
    useSettings.getState().setOverlayPosition('custom');
    void applyOverlayConfig();
  });
  if (gen !== startGen || !started) {
    off3();
    return;
  }
  unlisteners.push(off3);
  await applyOverlayConfig();
}

export async function stopGameMode(): Promise<void> {
  if (!started) return;
  started = false;
  // 注销当前注册的快捷键 + 设置里的快捷键（两者可能不一致：改键后未重新注册过）
  for (const hk of new Set([registeredHotkey, useSettings.getState().hotkey])) {
    if (!hk) continue;
    try {
      if (await isRegistered(hk)) await unregister(hk);
    } catch {
      // 忽略注销失败
    }
  }
  registeredHotkey = null;
  for (const off of unlisteners.splice(0)) off();
  await hideInputWindow();
  await (await getOverlayWindow())?.hide();
}
