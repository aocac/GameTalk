import { afterEach, describe, expect, it, vi } from 'vitest';
import { TEST_HTTP_URL, TEST_WS_URL } from './global-setup';
import { deviceId } from '../src/app/device';

// ---- 屏蔽 Tauri 运行时（chat store 间接 import gameMode/settings）----
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn(async () => undefined),
  listen: vi.fn(async () => () => undefined),
}));
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  WebviewWindow: { getByLabel: vi.fn(async () => null) },
}));
vi.mock('@tauri-apps/api/window', () => ({ primaryMonitor: vi.fn(async () => null) }));
vi.mock('@tauri-apps/api/dpi', () => ({
  PhysicalPosition: class {},
  PhysicalSize: class {},
}));
vi.mock('@tauri-apps/plugin-global-shortcut', () => ({
  isRegistered: vi.fn(async () => false),
  register: vi.fn(async () => undefined),
  unregister: vi.fn(async () => undefined),
}));
vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: vi.fn(async () => false),
  requestPermission: vi.fn(async () => 'denied'),
  sendNotification: vi.fn(),
}));

const { useAuth } = await import('../src/stores/auth');
const { useSettings } = await import('../src/app/settings');
const { useChat } = await import('../src/stores/chat');
const { ChatSocket } = await import('../src/app/ws');
import type { ServerWsMessage } from '../src/app/types';

useSettings.setState({ serverUrl: TEST_HTTP_URL });

async function register(username: string): Promise<{ token: string; userId: string }> {
  const res = await fetch(`${TEST_HTTP_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'password123' }),
  });
  const body = (await res.json()) as { token: string; user: { id: string } };
  return { token: body.token, userId: body.user.id };
}

async function createRoom(token: string, name: string): Promise<{ id: string; inviteCode: string }> {
  const res = await fetch(`${TEST_HTTP_URL}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ name }),
  });
  return ((await res.json()) as { room: { id: string; inviteCode: string } }).room;
}

async function joinRoomByCode(token: string, inviteCode: string): Promise<void> {
  await fetch(`${TEST_HTTP_URL}/api/rooms/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ inviteCode }),
  });
}

/** 用 store 自己的连接登录并等待房间列表/订阅就绪 */
async function connectStore(token: string, username: string, userId: string): Promise<void> {
  useAuth.setState({ token, user: { id: userId, username, avatarUrl: null } as never });
  useChat.getState().connect();
  await waitFor(() => useChat.getState().status === 'open' && useChat.getState().rooms.length > 0, 8000);
}

async function waitFor(pred: () => boolean, timeoutMs = 6000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('waitFor timeout');
}

/** 独立的旁观 socket（不属于 store），用于确认消息是否真的发到了服务端 */
async function connectSpectator(token: string, roomId: string): Promise<{ ws: ChatSocket; seen: string[] }> {
  const s = new ChatSocket();
  const seen: string[] = [];
  s.onMessage((m: ServerWsMessage) => {
    if (m.type === 'message:new') seen.push((m.payload as { message: { text: string } }).message.text);
  });
  const opened = new Promise<void>((resolve) => s.onStatus((st) => st === 'open' && resolve()));
  s.connect(TEST_WS_URL);
  await opened;
  s.send({ type: 'hello', payload: { token, deviceId: deviceId() } });
  await new Promise<void>((resolve) => {
    const off = s.onMessage((m) => {
      if (m.type === 'hello:ok') {
        off();
        resolve();
      }
    });
  });
  s.send({ type: 'room:join', payload: { roomId } });
  await new Promise<void>((resolve) => {
    const off = s.onMessage((m) => {
      if (m.type === 'room:joined') {
        off();
        resolve();
      }
    });
  });
  return { ws: s, seen };
}

afterEach(() => {
  useChat.getState().disconnect();
  useChat.getState().resetAccountState();
});

describe('客户端修复回归：纯图消息（无文字）不能被吞掉', () => {
  it('sendMessage("", { mediaUrls }) 会发出 message:send 并乐观上屏', async () => {
    const owner = await register('cimg_owner');
    const room = await createRoom(owner.token, '纯图房');
    await connectStore(owner.token, 'cimg_owner', owner.userId);
    const spectator = await connectSpectator(owner.token, room.id);
    await waitFor(() => useChat.getState().subscribedRoomIds.includes(room.id), 8000);

    useChat.getState().sendMessage('', { mediaUrls: ['/api/media/00000000-0000-4000-8000-000000000000'] });

    // 乐观气泡立刻出现（kind=image）
    const optimistic = useChat.getState().messagesByRoom[room.id] ?? [];
    expect(optimistic.length).toBe(1);
    expect(optimistic[0].kind).toBe('image');
    expect(optimistic[0].pending).toBe(true);

    // 服务端最终拒绝（媒体不存在），但关键是没有被客户端静默丢弃：错误码来自服务端
    await waitFor(() => (useChat.getState().messagesByRoom[room.id] ?? []).every((m) => !m.pending), 8000);
    expect(spectator.seen).toEqual([]);
    expect(useChat.getState().roomError).toBeTruthy();
    spectator.ws.close();
  });
});

describe('客户端修复：target_not_in_room 不得移除自己的房间', () => {
  it('房主踢一个已退房成员后，自己的房间仍在列表里', async () => {
    const owner = await register('ckick_owner');
    const member = await register('ckick_member');
    const room = await createRoom(owner.token, '踢人房');
    await joinRoomByCode(member.token, room.inviteCode);
    await connectStore(owner.token, 'ckick_owner', owner.userId);
    await waitFor(() => useChat.getState().subscribedRoomIds.includes(room.id), 8000);

    // 成员通过 REST 退房（DB 已无记录）
    await fetch(`${TEST_HTTP_URL}/api/rooms/${room.id}/leave`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${member.token}` },
    });

    useChat.getState().kickMember(room.id, member.userId);
    await waitFor(() => !!useChat.getState().roomError, 8000);

    // 关键断言：修复前这里会 removeRoomLocal 把房主自己的房间删掉
    expect(useChat.getState().rooms.some((r) => r.id === room.id)).toBe(true);
    expect(useChat.getState().activeRoomId).toBe(room.id);
    expect(useChat.getState().roomError).toContain('对方已不在该房间');
  });
});

describe('客户端修复：退出房间后历史标记要一起清', () => {
  it('leaveRoom 清掉历史标记，重新加入后能重新加载历史', async () => {
    const owner = await register('cleave_owner');
    const member = await register('cleave_member');
    const room = await createRoom(owner.token, '退房重进房');
    await joinRoomByCode(member.token, room.inviteCode);

    await connectStore(member.token, 'cleave_member', member.userId);
    await waitFor(() => useChat.getState().subscribedRoomIds.includes(room.id), 8000);
    await waitFor(() => useChat.getState().historyLoadedRooms[room.id] === true, 8000);

    // 成员主动退房：修复前 historyLoadedRooms 残留 true → 重新加入后聊天区永远空白
    await useChat.getState().leaveRoom(room.id);
    expect(useChat.getState().rooms.some((r) => r.id === room.id)).toBe(false);
    expect(useChat.getState().historyLoadedRooms[room.id]).toBeUndefined();
    expect(useChat.getState().hasMoreByRoom[room.id]).toBeUndefined();
    expect(useChat.getState().messagesByRoom[room.id]).toBeUndefined();

    // 重新用邀请码加入并选中：历史必须重新拉取
    await joinRoomByCode(member.token, room.inviteCode);
    await useChat.getState().refreshRooms();
    await useChat.getState().selectRoom(room.id);
    expect(useChat.getState().historyLoadedRooms[room.id]).toBe(true);
    expect(useChat.getState().messagesByRoom[room.id]).toBeDefined();
  });
});

describe('客户端修复：历史加载失败要能重试', () => {
  it('首次加载失败不标记已加载，恢复后再次选中可加载成功', async () => {
    const owner = await register('chist_owner');
    const room = await createRoom(owner.token, '历史重试房');
    await connectStore(owner.token, 'chist_owner', owner.userId);
    await waitFor(() => useChat.getState().subscribedRoomIds.includes(room.id), 8000);
    await waitFor(() => useChat.getState().historyLoadedRooms[room.id] === true, 8000);

    // 清掉已加载标记 + 消息，并把服务器地址指向一个不可达端口制造失败
    useChat.setState({
      historyLoadedRooms: {},
      messagesByRoom: {},
      roomError: null,
    });
    useSettings.setState({ serverUrl: 'http://127.0.0.1:1' });
    await useChat.getState().selectRoom(room.id);
    expect(useChat.getState().historyLoadedRooms[room.id]).toBeFalsy();

    // 恢复地址后再次选中：必须重新请求并成功（修复前标记为 true，永远不会再拉）
    useSettings.setState({ serverUrl: TEST_HTTP_URL });
    await useChat.getState().selectRoom(room.id);
    expect(useChat.getState().historyLoadedRooms[room.id]).toBe(true);
    expect(useChat.getState().messagesByRoom[room.id]).toBeDefined();
  });
});

describe('客户端修复：历史重载合并本地新消息', () => {
  it('forceReload 不会吞掉拉取期间到达的本地消息', async () => {
    const owner = await register('cmerge_owner');
    const room = await createRoom(owner.token, '合并房');
    await connectStore(owner.token, 'cmerge_owner', owner.userId);
    await waitFor(() => useChat.getState().subscribedRoomIds.includes(room.id), 8000);
    await waitFor(() => useChat.getState().historyLoadedRooms[room.id] === true, 8000);

    const serverMsgs = useChat.getState().messagesByRoom[room.id] ?? [];
    const localNew = {
      id: 'tmp-live-1',
      roomId: room.id,
      userId: owner.userId,
      username: 'cmerge_owner',
      avatarUrl: null,
      text: '拉取期间到达',
      createdAt: new Date(Date.now() + 60_000).toISOString(),
      kind: 'text' as const,
      mediaUrl: null,
      pending: true,
    };
    const stale = {
      ...localNew,
      id: 'stale-1',
      text: '不该复活',
      createdAt: '2000-01-01T00:00:00.000Z',
      pending: false,
    };
    useChat.setState({ messagesByRoom: { [room.id]: [...serverMsgs, localNew, stale] } });

    await useChat.getState().selectRoom(room.id, true);
    const merged = useChat.getState().messagesByRoom[room.id] ?? [];
    expect(merged.some((m) => m.id === 'tmp-live-1')).toBe(true);
    expect(merged.some((m) => m.id === 'stale-1')).toBe(false);
  });
});

describe('客户端修复：看门狗不得清掉排队中的消息', () => {
  it('断线期间排队的消息在重连后仍会发出（不再被强制重连清空）', async () => {
    const owner = await register('cqueue_owner');
    const room = await createRoom(owner.token, '排队房');
    await connectStore(owner.token, 'cqueue_owner', owner.userId);
    await waitFor(() => useChat.getState().subscribedRoomIds.includes(room.id), 8000);
    const spectator = await connectSpectator(owner.token, room.id);

    // 断开连接 → 排队一条消息 → 等它「变老」（旧代码此时会在重连后被看门狗误判半开而清空队列）
    useChat.getState().disconnect();
    useChat.getState().sendMessage('断线排队消息');
    await new Promise((r) => setTimeout(r, 6500));

    useChat.getState().connect();
    await waitFor(() => useChat.getState().status === 'open', 8000);
    await waitFor(() => spectator.seen.includes('断线排队消息'), 12000);
    expect(spectator.seen).toContain('断线排队消息');
    spectator.ws.close();
  }, 30000);
});

describe('客户端修复：私聊向上翻页 loading 态', () => {
  it('loadOlderDmMessages 期间写入 dm:<peer> 的 loading 标记并复位', async () => {
    const a = await register('cdm_a');
    const b = await register('cdm_b');
    useAuth.setState({ token: a.token, user: { id: a.userId, username: 'cdm_a', avatarUrl: null } as never });
    useChat.setState({
      dmHasMore: { [b.userId]: true },
      dmMessages: {
        [b.userId]: [
          {
            id: '00000000-0000-4000-8000-000000000001',
            roomId: '',
            userId: b.userId,
            username: 'cdm_b',
            avatarUrl: null,
            text: 'hi',
            createdAt: new Date().toISOString(),
            kind: 'text',
            mediaUrl: null,
          },
        ],
      },
      loadingOlderRooms: {},
    });

    const p = useChat.getState().loadOlderDmMessages(b.userId);
    expect(useChat.getState().loadingOlderRooms[`dm:${b.userId}`]).toBe(true);
    await p;
    expect(useChat.getState().loadingOlderRooms[`dm:${b.userId}`]).toBe(false);
  });
});

describe('客户端修复：窗口不在前台时当前会话也要计未读', () => {
  it('窗口失焦后，活跃房间的新消息计入未读', async () => {
    const owner = await register('cfocus_owner');
    const other = await register('cfocus_other');
    const room = await createRoom(owner.token, '焦点房');
    await joinRoomByCode(other.token, room.inviteCode);

    await connectStore(owner.token, 'cfocus_owner', owner.userId);
    await waitFor(() => useChat.getState().subscribedRoomIds.includes(room.id), 8000);
    // 前台且正看着该房间：不计未读
    expect(useChat.getState().mainWindowFocused).toBe(true);
    const before = useChat.getState().unreadByRoom[room.id] ?? 0;

    // 模拟窗口最小化/托盘：聚焦状态置 false，再让另一个账号发消息
    useChat.getState().setMainWindowFocused(false);
    const sender = await connectSpectator(other.token, room.id);
    await new Promise((r) => setTimeout(r, 300));
    sender.ws.send({ type: 'message:send', payload: { roomId: room.id, text: '后台消息' } });
    await waitFor(() => (useChat.getState().unreadByRoom[room.id] ?? 0) > before, 8000);
    expect(useChat.getState().unreadByRoom[room.id]).toBe(before + 1);

    // 回到前台后恢复「看着就不计未读」
    useChat.getState().setMainWindowFocused(true);
    sender.ws.send({ type: 'message:send', payload: { roomId: room.id, text: '前台消息' } });
    await new Promise((r) => setTimeout(r, 600));
    expect(useChat.getState().unreadByRoom[room.id]).toBe(before + 1);
    sender.ws.close();
  });
});

describe('客户端修复：换账号后在途请求不得污染新会话', () => {
  it('旧账号迟到的房间列表/历史被丢弃', async () => {
    const owner = await register('cgen_owner');
    const room = await createRoom(owner.token, '世代房');
    await connectStore(owner.token, 'cgen_owner', owner.userId);
    await waitFor(() => useChat.getState().subscribedRoomIds.includes(room.id), 8000);

    // 用延迟包装 api.listRooms，模拟「请求在途中登出并换号」
    const api = await import('../src/app/api');
    const realList = api.listRooms;
    let resolveList: ((v: { rooms: unknown[] }) => void) | null = null;
    const spy = vi.spyOn(api, 'listRooms').mockImplementation(
      () =>
        new Promise((res) => {
          resolveList = res as never;
        }) as never,
    );
    const pending = useChat.getState().refreshRooms();
    useChat.getState().resetAccountState(); // 世代自增
    resolveList?.({ rooms: [{ id: 'stale-room', name: '旧账号房间', inviteCode: 'X', ownerId: 'o', memberCount: 1, createdAt: '' }] });
    await pending;

    expect(useChat.getState().rooms.some((r) => r.id === 'stale-room')).toBe(false);
    spy.mockRestore();
    void realList;
  });
});

describe('同账号单设备登录：被新设备顶下线', () => {
  it('顶号后提示、清凭据、停止重连（不再自动重连，否则两端互相顶号会无限对踢）', async () => {
    const u = await register('kick_victim');
    await createRoom(u.token, '顶号测试房');
    await connectStore(u.token, 'kick_victim', u.userId);
    expect(useChat.getState().sessionReplaced).toBe(false);

    // 第二台设备（显式不同的 deviceId）登录同一账号
    const other = new ChatSocket();
    const opened = new Promise<void>((resolve) => other.onStatus((st) => st === 'open' && resolve()));
    other.connect(TEST_WS_URL);
    await opened;
    other.send({ type: 'hello', payload: { token: u.token, deviceId: 'other-device-abcd1234' } });
    await new Promise<void>((resolve) => {
      const off = other.onMessage((m) => {
        if (m.type === 'hello:ok') {
          off();
          resolve();
        }
      });
    });

    await waitFor(() => useChat.getState().sessionReplaced === true, 8000);
    expect(useChat.getState().status).toBe('closed');
    expect(useAuth.getState().token).toBeNull();
    expect(useAuth.getState().user).toBeNull();

    // 关键：不能再自动重连（否则两台设备会互相顶号形成死循环）
    await new Promise((r) => setTimeout(r, 800));
    expect(useChat.getState().status).toBe('closed');
    expect(useChat.getState().sessionReplaced).toBe(true);

    other.close();
  });
});
