import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettings } from '../src/app/settings';
import * as gameMode from '../src/app/gameMode';
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

const registered: string[] = [];
vi.mock('@tauri-apps/plugin-global-shortcut', () => ({
  isRegistered: vi.fn(async () => false),
  register: vi.fn(async (hotkey: string, handler: (e: { state: string }) => void) => {
    registered.push(hotkey);
    (globalThis as unknown as Record<string, unknown>)[`__hotkey_${hotkey}`] = handler;
  }),
  unregister: vi.fn(async () => undefined),
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
  registered.length = 0;
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
    expect(registered).toContain('Ctrl+Shift+Space');
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
    expect(emitted).toContainEqual({ event: 'overlay:config', payload: { scale: 1.5 } });
  });

  it('pushOverlayMessage emits append only while game mode started', async () => {
    await gameMode.pushOverlayMessage(sampleMessage); // 未启动：不 emit
    expect(emitted).toHaveLength(0);
    await gameMode.startGameMode();
    await gameMode.pushOverlayMessage(sampleMessage);
    expect(emitted).toContainEqual({ event: 'overlay:append', payload: sampleMessage });
  });

  it('stopGameMode unregisters and hides windows', async () => {
    await gameMode.startGameMode();
    const { hotkey } = useSettings.getState();
    await gameMode.stopGameMode();
    expect(gameMode.isGameModeRunning()).toBe(false);
    expect(hotkey).toBe('Ctrl+Shift+Space');
    expect(mockWindow.hide).toHaveBeenCalled();
  });
});
