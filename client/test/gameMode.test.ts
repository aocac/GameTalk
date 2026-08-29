import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettings } from '../src/app/settings';
import * as gameMode from '../src/app/gameMode';
import { isRegistered, register, unregister } from '@tauri-apps/plugin-global-shortcut';
import type { ChatMessage } from '../src/app/types';
// ---- mock Tauri APIs ----
const calls: string[] = [];
const mockWindow = {
  setSize: vi.fn(async () => undefined),
  setPosition: vi.fn(async () => undefined),
  show: vi.fn(async () => undefined),
  hide: vi.fn(async () => undefined),
  setFocus: vi.fn(async () => undefined),
};

vi.mock('@tauri-apps/api/webviewWindow', () => ({
  WebviewWindow: {
    getByLabel: vi.fn((label: string) => {
      calls.push(`getByLabel:${label}`);
      return Promise.resolve(mockWindow);
    }),
  },
}));

const emitted: Array<{ event: string; payload: unknown }> = [];
vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn(async (event: string, payload: unknown) => {
    emitted.push({ event, payload });
  }),
  listen: vi.fn(async (event: string, handler: (e: { payload: unknown }) => void) => {
    // 保存 handler 供测试触发
    (globalThis as unknown as Record<string, unknown>)[`__listener_${event}`] = handler;
    return () => undefined;
  }),
}));

vi.mock('@tauri-apps/api/dpi', () => ({
  PhysicalPosition: class {
    constructor(public x: number, public y: number) {}
  },
  PhysicalSize: class {
    constructor(public width: number, public height: number) {}
  },
}));

vi.mock('@tauri-apps/api/window', () => ({
  primaryMonitor: vi.fn(async () => ({
    position: { x: 0, y: 0 },
    size: { width: 1920, height: 1080 },
    scaleFactor: 1,
  })),
}));

/** 有状态的快捷键注册表：isRegistered/register/unregister 与真实插件语义一致 */
const registeredKeys = new Set<string>();
vi.mock('@tauri-apps/plugin-global-shortcut', () => ({
  isRegistered: vi.fn(async (hotkey: string) => registeredKeys.has(hotkey)),
  register: vi.fn(async (hotkey: string, handler: (e: { state: string }) => void) => {
    registeredKeys.add(hotkey);
    (globalThis as unknown as Record<string, unknown>)[`__hotkey_${hotkey}`] = handler;
  }),
  unregister: vi.fn(async (hotkey: string) => {
    registeredKeys.delete(hotkey);
  }),
}));

function fireEvent(name: string, payload?: unknown): void {
  const h = (globalThis as unknown as Record<string, unknown>)[`__listener_${name}`] as
    | ((e: { payload: unknown }) => void)
    | undefined;
  if (h) h({ payload });
}

function fireHotkey(hotkey: string): void {
  const h = (globalThis as unknown as Record<string, unknown>)[`__hotkey_${hotkey}`] as
    | ((e: { state: string }) => void)
    | undefined;
  if (h) h({ state: 'Pressed' });
}

const sampleMessage: ChatMessage = {
  id: 'm1',
  roomId: 'r1',
  userId: 'u1',
  username: 'Alice',
  text: '开黑！',
  createdAt: new Date().toISOString(),
};

beforeEach(() => {
  calls.length = 0;
  emitted.length = 0;
  registeredKeys.clear();
  useSettings.setState({
    gameModeEnabled: false,
    hotkey: 'Ctrl+Shift+Space',
    overlayPosition: 'bottom-left',
    overlayScale: 1,
    overlayDurationSec: 6,
  });
});

afterEach(async () => {
  await gameMode.stopGameMode();
  vi.clearAllMocks();
});

describe('gameMode manager', () => {
  it('startGameMode registers hotkey and listens to input events', async () => {
    await gameMode.startGameMode();
    expect(await isRegistered('Ctrl+Shift+Space')).toBe(true);
    expect(calls).toContain('getByLabel:overlay'); // applyOverlayConfig 会获取 overlay 窗口
  });

  it('hotkey press shows input window at bottom-center and focuses it', async () => {
    await gameMode.startGameMode();
    fireHotkey('Ctrl+Shift+Space');
    await vi.waitFor(() => expect(mockWindow.show).toHaveBeenCalled());
    await vi.waitFor(() => expect(mockWindow.setFocus).toHaveBeenCalled(), { timeout: 3000 });
    // 位置：底部居中（最后一次 setPosition 来自输入窗口）
    const pos = mockWindow.setPosition.mock.calls.at(-1)[0];
    expect(pos.x).toBe(Math.round((1920 - 460) / 2));
    expect(pos.y).toBe(1080 - 64 - 48);
  });

  it('hotkey press again hides the input window (toggle, Esc unaffected)', async () => {
    await gameMode.startGameMode();
    // 归一化到隐藏态（前序用例可能已把模块级 visible 标记置真）
    await gameMode.hideInputWindow();
    vi.clearAllMocks();
    fireHotkey('Ctrl+Shift+Space');
    await vi.waitFor(() => expect(mockWindow.show).toHaveBeenCalled());
    fireHotkey('Ctrl+Shift+Space');
    await vi.waitFor(() => expect(mockWindow.hide).toHaveBeenCalled());
  });

  it('game-input-send calls onSend and hides input window', async () => {
    const sent: string[] = [];
    gameMode.setOnSend((t) => sent.push(t));
    await gameMode.startGameMode();
    fireEvent('game-input-send', '  你好，世界  ');
    expect(sent).toEqual(['你好，世界']);
    await vi.waitFor(() => expect(mockWindow.hide).toHaveBeenCalled());
  });

  it('game-input-cancel hides input window without sending', async () => {
    const sent: string[] = [];
    gameMode.setOnSend((t) => sent.push(t));
    await gameMode.startGameMode();
    fireEvent('game-input-cancel');
    expect(sent).toHaveLength(0);
    await vi.waitFor(() => expect(mockWindow.hide).toHaveBeenCalled());
  });

  it('applyOverlayConfig sizes and positions overlay per settings, emits config', async () => {
    useSettings.setState({ overlayPosition: 'top-right', overlayScale: 1.5 });
    await gameMode.applyOverlayConfig();
    const sizeCall = mockWindow.setSize.mock.calls[0][0];
    expect(sizeCall.width).toBe(Math.round(380 * 1.5));
    expect(sizeCall.height).toBe(Math.round(180 * 1.5));
    const posCall = mockWindow.setPosition.mock.calls[0][0];
    expect(posCall.x).toBe(1920 - Math.round(380 * 1.5) - 20);
    expect(posCall.y).toBe(20);
    expect(emitted).toContainEqual({ event: 'overlay:config', payload: { scale: 1.5, durationSec: 6 } });
  });

  it('pushOverlayMessage emits append only while game mode started', async () => {
    await gameMode.pushOverlayMessage(sampleMessage); // 未启动：不 emit
    expect(emitted.filter((e) => e.event === 'overlay:append')).toHaveLength(0);
    await gameMode.startGameMode();
    await gameMode.pushOverlayMessage(sampleMessage);
    await gameMode.pushOverlayMessage(sampleMessage, '开黑小队', true); // 自己发送的消息也进 Overlay
    // 只统计 overlay:append（startGameMode 自身的 overlay:config 不算）
    const appends = emitted.filter((e) => e.event === 'overlay:append');
    expect(appends).toHaveLength(2);
    expect(appends[0]).toEqual({ event: 'overlay:append', payload: sampleMessage });
    expect(appends[1]).toEqual({
      event: 'overlay:append',
      payload: { ...sampleMessage, roomName: '开黑小队', isSelf: true },
    });
  });

  it('stopGameMode unregisters and hides windows', async () => {
    await gameMode.startGameMode();
    const { hotkey } = useSettings.getState();
    await gameMode.stopGameMode();
    expect(gameMode.isGameModeRunning()).toBe(false);
    expect(hotkey).toBe('Ctrl+Shift+Space');
    expect(await isRegistered('Ctrl+Shift+Space')).toBe(false);
    expect(mockWindow.hide).toHaveBeenCalled();
  });

  it('reapplyHotkey unregisters the old combo so it stops working', async () => {
    await gameMode.startGameMode();
    expect(await isRegistered('Ctrl+Shift+Space')).toBe(true);

    useSettings.setState({ hotkey: 'Alt+G' });
    await gameMode.reapplyHotkey();

    // 旧键必须被注销（真机反馈：换键后旧键仍可呼出）
    expect(unregister).toHaveBeenCalledWith('Ctrl+Shift+Space');
    expect(await isRegistered('Ctrl+Shift+Space')).toBe(false);
    expect(register).toHaveBeenCalledWith('Alt+G', expect.any(Function));
    expect(await isRegistered('Alt+G')).toBe(true);
  });

  it('pushOverlayEdit/Recall emit sync events; skipped when overlay disabled', async () => {
    await gameMode.startGameMode();
    useSettings.setState({ overlayEnabled: true });

    await gameMode.pushOverlayEdit('m1', '编辑后的文本');
    await gameMode.pushOverlayRecall('m1');
    expect(emitted.filter((e) => e.event === 'overlay:edit')).toEqual([
      { event: 'overlay:edit', payload: { messageId: 'm1', text: '编辑后的文本' } },
    ]);
    expect(emitted.filter((e) => e.event === 'overlay:recalled')).toEqual([
      { event: 'overlay:recalled', payload: { messageId: 'm1' } },
    ]);

    // 屏幕覆盖关闭：不 emit（不创建/唤醒窗口）
    emitted.length = 0;
    useSettings.setState({ overlayEnabled: false });
    await gameMode.pushOverlayEdit('m1', 'again');
    await gameMode.pushOverlayRecall('m1');
    expect(emitted.filter((e) => e.event.startsWith('overlay:'))).toEqual([]);
  });

  it('registers global Esc while input window is shown, unregisters on hide', async () => {
    await gameMode.startGameMode();
    expect(register).not.toHaveBeenCalledWith('Esc', expect.any(Function));

    // 呼出输入框 → 注册全局 Esc
    await gameMode.showInputWindow();
    expect(register).toHaveBeenCalledWith('Esc', expect.any(Function));

    // 即使焦点已离开输入框（模拟游戏内按 ESC），全局 Esc 也能关闭
    const escHandler = (globalThis as unknown as Record<string, unknown>)['__hotkey_Esc'] as
      | (() => void)
      | undefined;
    expect(escHandler).toBeDefined();
    escHandler!();
    await vi.waitFor(() => expect(mockWindow.hide).toHaveBeenCalled());
    await vi.waitFor(() => expect(unregister).toHaveBeenCalledWith('Esc'));
  });
});
