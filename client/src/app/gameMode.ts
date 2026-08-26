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

let started = false;
let onSend: SendHandler = () => undefined;
const unlisteners: UnlistenFn[] = [];

export function setOnSend(handler: SendHandler): void {
  onSend = handler;
}

function getInputWindow(): Promise<WebviewWindow | null> {
  return WebviewWindow.getByLabel(INPUT_WINDOW_LABEL);
}

function getOverlayWindow(): Promise<WebviewWindow | null> {
  return WebviewWindow.getByLabel(OVERLAY_WINDOW_LABEL);
}

export function isGameModeRunning(): boolean {
  return started;
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
  switch (pos) {
    case 'top-left':
      return new PhysicalPosition(x0 + margin, y0 + margin);
    case 'top-center':
      return new PhysicalPosition(x0 + (mon.size.width - w) / 2, y0 + margin);
    case 'top-right':
      return new PhysicalPosition(x0 + mon.size.width - w - margin, y0 + margin);
    case 'bottom-left':
      return new PhysicalPosition(x0 + margin, y0 + mon.size.height - h - margin);
    case 'bottom-center':
      return new PhysicalPosition(x0 + (mon.size.width - w) / 2, y0 + mon.size.height - h - margin);
    case 'bottom-right':
      return new PhysicalPosition(x0 + mon.size.width - w - margin, y0 + mon.size.height - h - margin);
    case 'custom':
      // 自定义位置走单独分支（applyOverlayConfig 已处理），此处兜底为左下
      return new PhysicalPosition(x0 + margin, y0 + mon.size.height - h - margin);
  }
}

/** 根据设置把消息 Overlay 摆到指定位置并按比例缩放 */
export async function applyOverlayConfig(): Promise<void> {
  const { overlayPosition, overlayScale, overlayCustomPosition } = useSettings.getState();
  const win = await getOverlayWindow();
  const mon = await primaryMonitor();
  if (!win || !mon) return;
  const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
  const w = Math.round(OVERLAY_BASE_WIDTH * overlayScale);
  const h = Math.round(OVERLAY_BASE_HEIGHT * overlayScale);
  await win.setSize(new PhysicalSize(Math.round(w * dpr), Math.round(h * dpr)));
  if (overlayPosition === 'custom' && overlayCustomPosition) {
    // 用户拖拽自定义位置（物理像素，左上角锚点）
    await win.setPosition(new PhysicalPosition(overlayCustomPosition.x, overlayCustomPosition.y));
  } else {
    await win.setPosition(computePosition(mon, w * dpr, h * dpr, overlayPosition, OVERLAY_MARGIN * dpr));
  }
  await emit('overlay:config', { scale: overlayScale });
}

/** 进入 Overlay 调整模式：可拖拽移动 + 滚轮缩放（overlay 窗口内操作） */
export async function startOverlayAdjust(): Promise<void> {
  await emit('overlay:adjust', { active: true });
}

/** 退出 Overlay 调整模式 */
export async function stopOverlayAdjust(): Promise<void> {
  await emit('overlay:adjust', { active: false });
}

/** 呼出输入框（全局快捷键触发）：定位底部居中 + 显示 + 聚焦 */
export async function showInputWindow(): Promise<void> {
  const win = await getInputWindow();
  const mon = await primaryMonitor();
  if (!win || !mon) return;
  const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
  const x = mon.position.x + (mon.size.width - INPUT_WIDTH * dpr) / 2;
  const y = mon.position.y + mon.size.height - INPUT_HEIGHT * dpr - INPUT_BOTTOM_MARGIN * dpr;
  await win.setPosition(new PhysicalPosition(Math.round(x), Math.round(y)));
  await win.show();
  // Windows 上 show 后需要一点时间才能聚焦
  setTimeout(() => void win.setFocus(), 60);
  // 输入框显示期间注册全局 ESC：即使焦点已切回游戏，按 ESC 也能关闭输入框
  await registerEsc();
}

export async function hideInputWindow(): Promise<void> {
  const win = await getInputWindow();
  await unregisterEsc();
  if (!win) return;
  await win.hide();
}

// ===== 全局 ESC（输入框显示期间生效，隐藏后立即注销，不干扰游戏内 ESC）=====
let escRegistered = false;

async function registerEsc(): Promise<void> {
  if (escRegistered) return;
  try {
    await register('Esc', () => {
      void hideInputWindow();
    });
    escRegistered = true;
  } catch (e) {
    console.error('register Esc failed:', e);
  }
}

async function unregisterEsc(): Promise<void> {
  if (!escRegistered) return;
  escRegistered = false;
  try {
    await unregister('Esc');
  } catch {
    // 忽略注销失败
  }
}

/** 新消息到达时推给 Overlay 显示（由 chat store 调用） */
export async function pushOverlayMessage(message: ChatMessage): Promise<void> {
  const win = await getOverlayWindow();
  if (!win || !started) return;
  await emit('overlay:append', message);
}

async function registerHotkey(): Promise<void> {
  const { hotkey } = useSettings.getState();
  try {
    if (await isRegistered(hotkey)) await unregister(hotkey);
    await register(hotkey, (event) => {
      if (event.state === 'Pressed') void showInputWindow();
    });
  } catch (e) {
    console.error('register hotkey failed:', e);
  }
}

/** 快捷键变更后重新注册（游戏模式运行中时由设置界面调用） */
export async function reapplyHotkey(): Promise<void> {
  if (!started) return;
  await registerHotkey();
}

export async function startGameMode(): Promise<void> {
  if (started) return;
  started = true;
  await registerHotkey();
  unlisteners.push(
    await listen('game-input-send', (e) => {
      const text = String(e.payload ?? '').trim();
      if (text) onSend(text);
      void hideInputWindow();
    }),
  );
  unlisteners.push(
    await listen('game-input-cancel', () => {
      void hideInputWindow();
    }),
  );
  // Overlay 调整完成：保存自定义位置/缩放并应用
  unlisteners.push(
    await listen('overlay:adjust-done', (e) => {
      const p = (e.payload ?? {}) as { position?: { x: number; y: number }; scale?: number };
      if (p.position) useSettings.getState().setOverlayCustomPosition(p.position);
      if (typeof p.scale === 'number') useSettings.getState().setOverlayScale(p.scale);
      useSettings.getState().setOverlayPosition('custom');
      void applyOverlayConfig();
    }),
  );
  await applyOverlayConfig();
}

export async function stopGameMode(): Promise<void> {
  if (!started) return;
  started = false;
  const { hotkey } = useSettings.getState();
  try {
    if (await isRegistered(hotkey)) await unregister(hotkey);
  } catch {
    // 忽略注销失败
  }
  for (const off of unlisteners.splice(0)) off();
  await hideInputWindow();
  await (await getOverlayWindow())?.hide();
}
