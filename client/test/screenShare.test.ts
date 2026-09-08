import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScreenShareManager, QUALITY_PRESETS, MIN_PER_VIEWER_BPS } from '../src/app/screenShare';

/**
 * ScreenShareManager 单元测试：用假的 RTCPeerConnection 覆盖连接生命周期、
 * 码率分摊/档位、重复 request 的非破坏性、ICE 断线重启。
 * 这些是最容易「改 A 坏 B」的地方，之前完全没有自动化覆盖。
 */

type Signal = { to: string; roomId: string; data: unknown };

class FakeSender {
  params = { encodings: [{}] } as unknown as RTCRtpSendParameters;
  setCalls: Array<Record<string, unknown>> = [];
  /** 设为非 0 时，接下来 N 次 setParameters 以 InvalidModificationError 拒绝 */
  failNext = 0;
  constructor(public track: { kind: string }) {}
  getParameters(): RTCRtpSendParameters {
    return { ...this.params, encodings: [{ ...this.params.encodings[0] }] };
  }
  setParameters(p: RTCRtpSendParameters): Promise<void> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      return Promise.reject(Object.assign(new Error('rejected'), { name: 'InvalidModificationError' }));
    }
    this.params = p;
    this.setCalls.push({
      ...(p.encodings[0] as unknown as Record<string, unknown>),
      degradationPreference: (p as unknown as Record<string, unknown>).degradationPreference,
    });
    return Promise.resolve();
  }
}

class FakePC {
  static instances: FakePC[] = [];
  localDescription: unknown = null;
  remoteDescription: unknown = null;
  iceConnectionState: RTCIceConnectionState = 'new';
  onicecandidate: ((ev: { candidate: { toJSON: () => unknown } | null }) => void) | null = null;
  ontrack: ((ev: { streams: unknown[] }) => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  onnegotiationneeded: (() => void) | null = null;
  senders: FakeSender[] = [];
  restartIceCalls = 0;
  closed = false;
  constructor() {
    FakePC.instances.push(this);
  }
  addTrack(track: { kind: string }): FakeSender {
    const s = new FakeSender(track);
    this.senders.push(s);
    return s;
  }
  getSenders(): FakeSender[] {
    return this.senders;
  }
  createOffer(): Promise<{ type: string; sdp: string }> {
    return Promise.resolve({ type: 'offer', sdp: 'v=0-offer' });
  }
  createAnswer(): Promise<{ type: string; sdp: string }> {
    return Promise.resolve({ type: 'answer', sdp: 'v=0-answer' });
  }
  setLocalDescription(d: unknown): Promise<void> {
    this.localDescription = d;
    return Promise.resolve();
  }
  setRemoteDescription(d: unknown): Promise<void> {
    this.remoteDescription = d;
    return Promise.resolve();
  }
  addIceCandidate(): Promise<void> {
    return Promise.resolve();
  }
  close(): void {
    this.closed = true;
    this.iceConnectionState = 'closed';
  }
  restartIce(): void {
    this.restartIceCalls += 1;
  }
  getStats(): Promise<Map<string, unknown>> {
    return Promise.resolve(new Map());
  }
  setIce(state: RTCIceConnectionState): void {
    this.iceConnectionState = state;
    this.oniceconnectionstatechange?.();
  }
}

const fakeVideoTrack = { kind: 'video', contentHint: '', addEventListener: vi.fn(), stop: vi.fn() };
const fakeStream = {
  getVideoTracks: () => [fakeVideoTrack],
  getAudioTracks: () => [],
  getTracks: () => [fakeVideoTrack],
};

const signals: Signal[] = [];

beforeEach(() => {
  FakePC.instances = [];
  signals.length = 0;
  vi.stubGlobal('RTCPeerConnection', FakePC);
  vi.stubGlobal('RTCSessionDescription', class { constructor(public init: unknown) {} });
  vi.stubGlobal('RTCIceCandidate', class { constructor(public init: unknown) {} });
  vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia: vi.fn(async () => fakeStream) } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function makeManager(): ScreenShareManager {
  const mgr = new ScreenShareManager();
  mgr.setSignalSender((to, roomId, data) => signals.push({ to, roomId, data }));
  return mgr;
}

async function startSharing(mgr: ScreenShareManager): Promise<void> {
  await mgr.start('room-1', (to, roomId, data) => signals.push({ to, roomId, data }), () => undefined);
}

describe('ScreenShareManager：连接生命周期', () => {
  it('watch() 建 receiver 并发带 cid 的 request；offer 到达后回 answer', async () => {
    const mgr = makeManager();
    mgr.watch('sharer-1', 'room-1');
    const req = signals.find((s) => (s.data as { type: string }).type === 'request');
    expect(req?.to).toBe('sharer-1');
    const cid = (req?.data as { cid: string }).cid;
    expect(cid).toBeTruthy();
    expect(FakePC.instances.length).toBe(1);

    await mgr.handleSignal('sharer-1', 'room-1', { type: 'offer', cid, sdp: 'v=0-remote' });
    const answer = signals.find((s) => (s.data as { type: string }).type === 'answer');
    expect(answer).toBeTruthy();
    expect(FakePC.instances[0]!.remoteDescription).toMatchObject({ init: { type: 'offer', sdp: 'v=0-remote' } });
  });

  it('stopWatching() 发 bye 并释放连接', async () => {
    const mgr = makeManager();
    mgr.watch('sharer-1', 'room-1');
    mgr.stopWatching('sharer-1');
    expect(signals.some((s) => (s.data as { type: string }).type === 'bye')).toBe(true);
    expect(FakePC.instances[0]!.closed).toBe(true);
  });

  it('重复 request（信令重连后重发）不会拆掉已连通的 sender 连接', async () => {
    const mgr = makeManager();
    await startSharing(mgr);

    await mgr.handleSignal('viewer-1', 'room-1', { type: 'request', cid: 'cid-a' });
    const first = FakePC.instances[0]!;
    expect(first.senders.length).toBeGreaterThan(0);

    // 连接已就绪后再次收到同一个 cid 的 request：必须复用，不 close
    first.setIce('connected');
    await mgr.handleSignal('viewer-1', 'room-1', { type: 'request', cid: 'cid-a' });
    expect(first.closed).toBe(false);
    expect(FakePC.instances.length).toBe(1);

    // 连接已失败时再次 request：应当重建
    first.setIce('failed');
    await mgr.handleSignal('viewer-1', 'room-1', { type: 'request', cid: 'cid-a' });
    expect(first.closed).toBe(true);
    expect(FakePC.instances.length).toBe(2);
  });

  it('resendRequests() 用原 cid 重发 request（观看端信令重连用）', async () => {
    const mgr = makeManager();
    mgr.watch('sharer-1', 'room-1');
    const cid = (signals.find((s) => (s.data as { type: string }).type === 'request')?.data as { cid: string }).cid;
    signals.length = 0;
    mgr.resendRequests();
    expect(signals.length).toBe(1);
    expect(signals[0]).toMatchObject({ to: 'sharer-1', roomId: 'room-1' });
    expect((signals[0]!.data as { cid: string }).cid).toBe(cid);
  });
});

describe('ScreenShareManager：码率分摊与档位', () => {
  it('按观看人数分摊总预算，单路不超过档位上限、不低于下限', async () => {
    const mgr = makeManager();
    mgr.setBudgetBps(12_000_000);
    mgr.setQuality('balanced'); // 显式档位，验证分摊本身
    await startSharing(mgr);

    // 1 个观看者：12M 预算 → 受 balanced 上限 4M 限制
    await mgr.handleSignal('v1', 'room-1', { type: 'request', cid: 'c1' });
    expect(mgr.getTargetBps()).toBe(4_000_000);

    // 4 个观看者：12M/4 = 3M
    await mgr.handleSignal('v2', 'room-1', { type: 'request', cid: 'c2' });
    await mgr.handleSignal('v3', 'room-1', { type: 'request', cid: 'c3' });
    await mgr.handleSignal('v4', 'room-1', { type: 'request', cid: 'c4' });
    expect(mgr.getTargetBps()).toBe(3_000_000);

    // 12 个观看者：12M/12 = 1M，但受下限保护
    for (let i = 5; i <= 12; i++) await mgr.handleSignal(`v${i}`, 'room-1', { type: 'request', cid: `c${i}` });
    expect(mgr.getTargetBps()).toBe(MIN_PER_VIEWER_BPS);
    expect(mgr.snapshot().peers.length).toBe(12);
  });

  it('切档位会重设所有 sender 的编码参数（含降采样与降级偏好）', async () => {
    const mgr = makeManager();
    await startSharing(mgr);
    await mgr.handleSignal('v1', 'room-1', { type: 'request', cid: 'c1' });
    const sender = FakePC.instances[0]!.senders[0]!;

    mgr.setQuality('low');
    const last = sender.setCalls[sender.setCalls.length - 1] as { scaleResolutionDownBy: number; degradationPreference: string };
    expect(last.scaleResolutionDownBy).toBe(QUALITY_PRESETS.low.scale);
    expect(last.degradationPreference).toBe('balanced');

    mgr.setQuality('quality');
    const last2 = sender.setCalls[sender.setCalls.length - 1] as { degradationPreference: string };
    expect(last2.degradationPreference).toBe('maintain-resolution');
  });
});

describe('ScreenShareManager：自动档位（按观看人数选档）', () => {
  it('auto 随观看人数在 清晰/流畅/省流 之间切换', async () => {
    const mgr = makeManager();
    mgr.setBudgetBps(12_000_000);
    mgr.setQuality('auto');
    await startSharing(mgr);

    await mgr.handleSignal('v1', 'room-1', { type: 'request', cid: 'c1' });
    expect(mgr.getEffectiveQuality()).toBe('quality'); // 12M/1 ≥ 5M

    await mgr.handleSignal('v2', 'room-1', { type: 'request', cid: 'c2' });
    await mgr.handleSignal('v3', 'room-1', { type: 'request', cid: 'c3' });
    expect(mgr.getEffectiveQuality()).toBe('balanced'); // 12M/3 = 4M

    for (let i = 4; i <= 6; i++) await mgr.handleSignal(`v${i}`, 'room-1', { type: 'request', cid: `c${i}` });
    expect(mgr.getEffectiveQuality()).toBe('low'); // 12M/6 = 2M → 落到省流量档
    expect(mgr.getTargetBps()).toBe(1_500_000); // 受省流量档 1.5M 上限约束
  });

  it('手动锁定档位时不再随人数变化', async () => {
    const mgr = makeManager();
    mgr.setBudgetBps(12_000_000);
    mgr.setQuality('quality');
    await startSharing(mgr);
    for (let i = 1; i <= 6; i++) await mgr.handleSignal(`v${i}`, 'room-1', { type: 'request', cid: `c${i}` });
    expect(mgr.getEffectiveQuality()).toBe('quality');
  });
});

describe('ScreenShareManager：参数下发失败回退', () => {
  it('setParameters 被拒时退回只改码率，并记录 paramError', async () => {
    const mgr = makeManager();
    await startSharing(mgr);
    await mgr.handleSignal('v1', 'room-1', { type: 'request', cid: 'c1' });
    const sender = FakePC.instances[0]!.senders[0]!;

    const before = sender.setCalls.length;
    sender.failNext = 1; // 下一次完整参数下发被拒
    mgr.setQuality('quality');
    await new Promise((r) => setTimeout(r, 0));

    // 被拒的那次不落账，回退调用成功且只带码率
    expect(sender.setCalls.length).toBe(before + 1);
    const fallback = sender.setCalls[sender.setCalls.length - 1] as { maxBitrate?: number };
    expect(fallback.maxBitrate).toBe(6_000_000);
    expect(mgr.snapshot().paramError).toBe('InvalidModificationError');
  });
});

describe('ScreenShareManager：ICE 断线自愈', () => {
  it('disconnected 2s 后重启 ICE，connected 后复位', async () => {
    vi.useFakeTimers();
    const mgr = makeManager();
    await startSharing(mgr);
    await mgr.handleSignal('v1', 'room-1', { type: 'request', cid: 'c1' });
    const pc = FakePC.instances[0]!;

    pc.setIce('disconnected');
    expect(pc.restartIceCalls).toBe(0);
    vi.advanceTimersByTime(2100);
    expect(pc.restartIceCalls).toBe(1);

    pc.setIce('connected');
    pc.setIce('disconnected');
    vi.advanceTimersByTime(2100);
    expect(pc.restartIceCalls).toBe(2);
  });

  it('failed 立即（500ms）触发重启', async () => {
    vi.useFakeTimers();
    const mgr = makeManager();
    await startSharing(mgr);
    await mgr.handleSignal('v1', 'room-1', { type: 'request', cid: 'c1' });
    const pc = FakePC.instances[0]!;
    pc.setIce('failed');
    vi.advanceTimersByTime(600);
    expect(pc.restartIceCalls).toBe(1);
  });
});
