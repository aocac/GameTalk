/**
 * 屏幕共享：P2P WebRTC，请求/应答式，按连接 ID（cid）多路复用。
 * - 共享者：getDisplayMedia 取流后只广播「我在共享」，观看端发 request 才为它建连接（晚加入友好）。
 * - 每条观看连接用独立的 cid 标识：同一用户多台设备 / 多个窗口同时观看互不干扰。
 * - 一个客户端可同时是共享者（senders）和观看者（receivers）。
 * - SDP / ICE 经服务端 screen:signal 定向透传，媒体流不经服务器。
 *
 * 码率策略（v0.8 起）：
 * - 上行是 mesh 的瓶颈：每多一个观看者就多一路编码。因此按「总预算 / 观看人数」分摊，
 *   每路有下限（低于下限就不再降，转而提示用户少拉人或降画质档位）。
 * - 画质档位决定单路上限与分辨率/帧率的取舍：
 *     quality（清晰优先）  保分辨率，带宽不足时掉帧
 *     balanced（流畅优先） 保帧率，带宽不足时降分辨率（游戏画面默认）
 *     low（省流量）       低码率 + 主动降分辨率
 * - 每 2s 读 getStats 自适应：丢包/延迟高就下调（最低到下限的 60%），恢复后再升回去。
 * - ICE 断开自动 restartIce（退避 2/4/8s，连上即复位），网络抖动不再直接断流。
 */

const STUN_SERVERS: RTCIceServer[] = [
  // 国内可达优先；Google 公共 STUN 作兜底（部分网络可达）
  { urls: 'stun:stun.qq.com:3478' },
  { urls: 'stun:stun.chat.bilibili.com:3478' },
  { urls: 'stun:stun.aliyun.com:3478' },
  { urls: 'stun:stun.miwifi.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.stunprotocol.org:3478' },
];

/**
 * 免费公共 TURN 中继（metered OpenRelay，静态密钥模式）兜底：仅当 P2P 直连打不通时才用到，
 * 走第三方带宽，不消耗自己服务器。OpenRelay 现用 REST/HMAC 临时凭据（旧的静态 openrelayproject 已废弃），
 * 故在本地用共享密钥签发 username/credential。正式/高负载或国内直连不稳时应自建 coturn。
 */
const TURN_SECRET = 'openrelayprojectsecret';
const TURN_HOST = 'staticauth.openrelay.metered.ca';

type DisplayMediaOptionsWithAudioHints = DisplayMediaStreamOptions & {
  systemAudio?: 'include' | 'exclude';
  windowAudio?: 'exclude' | 'window' | 'system';
};

/** 画质档位：auto = 按观看人数与预算自动选档 */
export type ShareQuality = 'auto' | 'quality' | 'balanced' | 'low';
/** 实际生效的具体档位（auto 会解析成其中之一） */
export type EffectiveQuality = 'quality' | 'balanced' | 'low';

export interface ShareQualityPreset {
  label: string;
  /** 单路码率上限（bps） */
  maxBitrate: number;
  /** 分辨率降采样倍数（1 = 原始） */
  scale: number;
  /** 编码器降级偏好：保分辨率（掉帧）还是保帧率（降分辨率） */
  degradation: 'maintain-resolution' | 'balanced';
}

export const QUALITY_PRESETS: Record<EffectiveQuality, ShareQualityPreset> = {
  quality: { label: '清晰优先', maxBitrate: 6_000_000, scale: 1, degradation: 'maintain-resolution' },
  balanced: { label: '流畅优先', maxBitrate: 4_000_000, scale: 1, degradation: 'balanced' },
  low: { label: '省流量', maxBitrate: 1_500_000, scale: 1.5, degradation: 'balanced' },
};

export const QUALITY_OPTIONS: ShareQuality[] = ['auto', 'quality', 'balanced', 'low'];

export function qualityLabel(q: ShareQuality): string {
  return q === 'auto' ? '自动' : QUALITY_PRESETS[q].label;
}

/** auto 的选档规则：按每路能分到的预算决定清晰度与帧率取舍 */
export function resolveEffectiveQuality(quality: ShareQuality, viewers: number, budgetBps: number): EffectiveQuality {
  if (quality !== 'auto') return quality;
  const perViewer = budgetBps / Math.max(1, viewers);
  if (perViewer >= 5_000_000) return 'quality';
  if (perViewer >= 2_500_000) return 'balanced';
  return 'low';
}

/** 每路码率下限：低于这个值画面就没法看了，宁可不降 */
export const MIN_PER_VIEWER_BPS = 1_200_000;
/** 自适应下限系数（相对分摊目标） */
const ADAPT_FLOOR = 0.6;
/** 默认总上行预算（bps） */
export const DEFAULT_BUDGET_BPS = 12_000_000;

export interface SharePeerStats {
  cid: string;
  /** ICE 连接状态（connected 时带链路类型，如 connected·srflx↔host） */
  state: string;
  kbps: number;
  fps: number;
  width: number;
  height: number;
  rttMs: number;
  lossPct: number;
}

export interface ShareStats {
  role: 'sharer' | 'viewer' | 'idle';
  audio: boolean;
  quality: ShareQuality;
  /** 实际生效的档位（auto 解析后的结果） */
  effectiveQuality: EffectiveQuality;
  /** 最近一次编码参数下发失败的原因（正常为 null） */
  paramError: string | null;
  /** 总上行预算（共享端） */
  budgetBps: number;
  /** 每路当前目标码率（共享端） */
  targetBps: number;
  /** 实测合计码率 */
  totalKbps: number;
  peers: SharePeerStats[];
}

export type SignalSender = (to: string, roomId: string, data: unknown) => void;

type SignalPayload = {
  type: 'request' | 'offer' | 'answer' | 'candidate' | 'bye';
  /** 连接 ID：同一用户的多端 / 多窗口各自一条观看连接 */
  cid?: string;
  sdp?: string;
  candidate?: RTCIceCandidateInit;
};

/** 每条连接的统计与自愈状态 */
interface PeerMeta {
  /** 上一次采样时的累计字节与时间戳（算码率用） */
  lastBytes: number;
  lastTs: number;
  kbps: number;
  fps: number;
  width: number;
  height: number;
  rttMs: number;
  lossPct: number;
  /** 链路类型（host/srflx/relay），连上后从 candidate-pair 读取 */
  transport: string;
  /** ICE 断开后的重启计时器与次数 */
  restartTimer: ReturnType<typeof setTimeout> | null;
  restarts: number;
}

let cachedTurn: RTCIceServer | null = null;
let turnPromise: Promise<void> | null = null;

async function mintTurnCredential(): Promise<void> {
  try {
    const username = `${Math.floor(Date.now() / 1000) + 86400}:openrelayproject`;
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode(TURN_SECRET), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(username));
    const credential = btoa(String.fromCharCode(...new Uint8Array(sig)));
    cachedTurn = {
      urls: [`turn:${TURN_HOST}:80`, `turn:${TURN_HOST}:80?transport=tcp`, `turns:${TURN_HOST}:443`],
      username,
      credential,
    };
  } catch {
    cachedTurn = null;
  }
}

/** 预热 TURN 凭据（应用启动即异步签好，用户点共享/观看时已就绪）。 */
export function ensureTurnCredential(): void {
  if (!turnPromise) turnPromise = mintTurnCredential();
}

function iceServers(extra: RTCIceServer[] = []): RTCIceServer[] {
  return [...extra, ...STUN_SERVERS, ...(cachedTurn ? [cachedTurn] : [])];
}

// 模块加载即预热 TURN 凭据（用户点共享/观看时通常已就绪）
ensureTurnCredential();

export class ScreenShareManager {
  private localStream: MediaStream | null = null;
  /** 我作为共享者：cid -> sender pc */
  private senders = new Map<string, RTCPeerConnection>();
  /** 我作为观看者：cid -> receiver pc */
  private receivers = new Map<string, RTCPeerConnection>();
  /** cid -> 对端用户 ID */
  private peerOfCid = new Map<string, string>();
  /** cid -> 所属房间（回发信令时带上正确的 roomId） */
  private roomOfCid = new Map<string, string>();
  /** 观看端：共享者 ID -> 我当前观看它的 cid */
  private cidOfPeer = new Map<string, string>();
  /** 每条连接的统计与自愈状态 */
  private meta = new Map<string, PeerMeta>();
  private signalSender: SignalSender | null = null;
  private onRemoteStream: ((sharerId: string, stream: MediaStream) => void) | null = null;
  private onSelfStop: (() => void) | null = null;
  private onIceState: ((peerId: string, state: string) => void) | null = null;
  /** 服务端 /api/turn 签发的自建 coturn 凭据（首选 TURN；OpenRelay 兜底在其后） */
  private extraIceServers: RTCIceServer[] = [];
  /** 本次共享是否包含音频 */
  private selfAudio = false;
  private quality: ShareQuality = 'auto';
  private lastParamError: string | null = null;
  private budgetBps = DEFAULT_BUDGET_BPS;
  /** 自适应系数：1 = 满码率，最低 ADAPT_FLOOR */
  private adapt = 1;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private lastAdaptAt = 0;

  get isSharing(): boolean {
    return this.localStream !== null;
  }

  setSignalSender(fn: SignalSender): void {
    this.signalSender = fn;
  }

  setRemoteStreamHandler(fn: (sharerId: string, stream: MediaStream) => void): void {
    this.onRemoteStream = fn;
  }

  setIceStateHandler(fn: (peerId: string, state: string) => void): void {
    this.onIceState = fn;
  }

  setExtraIceServers(list: RTCIceServer[]): void {
    this.extraIceServers = list;
  }

  /** 画质档位（共享端生效；观看端也会记录，用于界面显示） */
  setQuality(q: ShareQuality): void {
    if (this.quality === q) return;
    this.quality = q;
    this.applyAllSenderParams();
  }

  getQuality(): ShareQuality {
    return this.quality;
  }

  /** 当前实际生效的档位（auto 按观看人数与预算解析） */
  getEffectiveQuality(): EffectiveQuality {
    return resolveEffectiveQuality(this.quality, Math.max(1, this.senders.size), this.budgetBps);
  }

  /** 总上行预算（共享端生效）：按观看人数分摊 */
  setBudgetBps(bps: number): void {
    const next = Math.max(2_000_000, Math.min(50_000_000, Math.round(bps)));
    if (this.budgetBps === next) return;
    this.budgetBps = next;
    this.applyAllSenderParams();
  }

  /** 每路当前目标码率（分摊结果 × 自适应系数） */
  getTargetBps(): number {
    const viewers = Math.max(1, this.senders.size);
    const share = Math.round(this.budgetBps / viewers);
    const base = Math.max(MIN_PER_VIEWER_BPS, Math.min(QUALITY_PRESETS[this.getEffectiveQuality()].maxBitrate, share));
    return Math.round(base * this.adapt);
  }

  /** 统计快照（UI 每 1~2s 轮询；内部采样定时器负责刷新） */
  snapshot(): ShareStats {
    const peers: SharePeerStats[] = [];
    for (const [cid, pc] of [...this.senders, ...this.receivers]) {
      const m = this.meta.get(cid);
      peers.push({
        cid,
        state: m ? `${pc.iceConnectionState}${m.transport ? `·${m.transport}` : ''}` : pc.iceConnectionState,
        kbps: m?.kbps ?? 0,
        fps: m?.fps ?? 0,
        width: m?.width ?? 0,
        height: m?.height ?? 0,
        rttMs: m?.rttMs ?? 0,
        lossPct: m?.lossPct ?? 0,
      });
    }
    const role: ShareStats['role'] = this.localStream ? 'sharer' : this.receivers.size > 0 ? 'viewer' : 'idle';
    return {
      role,
      audio: this.selfAudio,
      quality: this.quality,
      effectiveQuality: this.getEffectiveQuality(),
      paramError: this.lastParamError,
      budgetBps: this.budgetBps,
      targetBps: this.getTargetBps(),
      totalKbps: peers.reduce((sum, p) => sum + p.kbps, 0),
      peers,
    };
  }

  /** 发起共享：请求屏幕 + 系统声音；最终是否有音轨由 WebView2 原生选择器决定。
   *  用户取消选择器时静默返回（isSharing 保持 false）。windowAudio 是 Chromium/WebView2
   *  的提示字段，是否支持窗口源音频取决于运行时，不能替代 getAudioTracks() 实测。 */
  async start(roomId: string, signalSender: SignalSender, onSelfStop: () => void): Promise<void> {
    this.signalSender = signalSender;
    this.onSelfStop = onSelfStop;
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error('当前运行环境不支持屏幕捕获（WebView2 版本过旧，或非安全上下文）');
    }
    if (this.localStream) return; // 已在共享，幂等
    try {
      this.localStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30, max: 60 } },
        // WebView2：audio:true 请求音频轨，systemAudio:'include' 让整屏选择提供系统音频；
        // windowAudio:'window' 是窗口源的实验性提示，旧 runtime 会忽略它，选择器仍是最终裁决。
        audio: true,
        systemAudio: 'include',
        windowAudio: 'window',
      } as DisplayMediaOptionsWithAudioHints);
    } catch (e) {
      const name = (e as DOMException)?.name ?? '';
      if (name === 'NotAllowedError') {
        // 用户在系统选择器点了取消/未选择：不是故障，静默返回
        this.onSelfStop = null;
        return;
      }
      this.onSelfStop = null;
      throw new Error(`无法获取屏幕（${name || '未知错误'}）。请确认窗口高度 ≥600px 且 WebView2 支持屏幕捕获。`, { cause: e });
    }
    // 屏幕内容默认按「保分辨率」降级，带宽不足时疯狂掉帧；游戏画面改为帧率优先
    const track = this.localStream.getVideoTracks()[0];
    if (track) track.contentHint = 'motion';
    this.selfAudio = this.localStream.getAudioTracks().length > 0;
    this.roomOfCid.set('__self__', roomId);
    this.adapt = 1;
    this.localStream.getVideoTracks()[0]?.addEventListener('ended', () => this.stopLocal());
    this.startStats();
  }

  /** 本次共享是否包含音频（系统声音）；供主窗口抑制本地提示音（避免回流进共享流） */
  get hasAudio(): boolean {
    return this.selfAudio;
  }

  /** 本地采集流（采集窗控制条预览用；只读，调用方不要 stop 它） */
  localStreamForPreview(): MediaStream | null {
    return this.localStream;
  }

  /** 我作为观看者，主动请求观看 sharerId 的共享（晚加入靠这个触发共享者重新 offer） */
  watch(sharerId: string, roomId: string): void {
    // 同一共享者已有存活的观看连接时幂等（重看同一路不重复建）
    const existingCid = this.cidOfPeer.get(sharerId);
    if (existingCid && this.receivers.has(existingCid)) return;
    if (existingCid) this.dropReceiver(existingCid);
    const cid = crypto.randomUUID?.() ?? `cid-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.cidOfPeer.set(sharerId, cid);
    this.peerOfCid.set(cid, sharerId);
    this.roomOfCid.set(cid, roomId);
    this.receivers.set(cid, this.createPeerConnection(cid, false));
    this.signalSender?.(sharerId, roomId, { type: 'request', cid });
    this.startStats();
  }

  /** 停止观看某个共享者：释放本地连接并通知共享者释放对应的那一路 */
  stopWatching(sharerId: string): void {
    const cid = this.cidOfPeer.get(sharerId);
    if (!cid) return;
    const roomId = this.roomOfCid.get(cid) ?? '';
    this.signalSender?.(sharerId, roomId, { type: 'bye', cid });
    this.dropReceiver(cid);
  }

  /** 信令通道重连后重发观看请求（带原 cid）：共享端对已连通的连接保持不动，媒体不中断 */
  resendRequests(): void {
    for (const [sharerId, cid] of this.cidOfPeer) {
      const roomId = this.roomOfCid.get(cid) ?? '';
      this.signalSender?.(sharerId, roomId, { type: 'request', cid });
    }
  }

  /** 处理收到的信令（from 为对端用户 ID，roomId 为该共享所属房间） */
  async handleSignal(from: string, roomId: string, raw: unknown): Promise<void> {
    const data = raw as SignalPayload;
    const type = data?.type;
    const cid = typeof data?.cid === 'string' && data.cid ? data.cid : '';

    if (type === 'bye') {
      // 对端观看端关闭/断开：按 cid 释放那一连接；无 cid（旧客户端）则释放该用户的所有连接
      if (cid) {
        this.dropConnection(cid);
      } else {
        for (const [c, peer] of [...this.peerOfCid]) {
          if (peer === from) this.dropConnection(c);
        }
      }
      return;
    }

    if (type === 'request') {
      // 我是共享者：为该观看连接建 sender 并 addTrack（触发 onnegotiationneeded → offer）
      if (!this.localStream) return;
      const key = cid || `legacy-${from}`;
      this.peerOfCid.set(key, from);
      this.roomOfCid.set(key, roomId);
      const existing = this.senders.get(key);
      if (existing) {
        const st = existing.iceConnectionState;
        // 重复 request（观看端信令重连后重发，带同一个 cid）：连接还活着就保持不动，
        // 否则会把正在跑的媒体连接拆掉重建——这是重连场景最容易踩的坑
        if (st === 'connected' || st === 'completed' || st === 'checking' || st === 'new') {
          this.applyAllSenderParams();
          return;
        }
        existing.close();
      }
      this.senders.set(key, this.createPeerConnection(key, true));
      for (const track of this.localStream.getTracks()) {
        const sender = this.senders.get(key)!.addTrack(track, this.localStream);
        this.applySenderParams(sender, track.kind);
      }
      // 观看人数变了 → 重新分摊码率
      this.applyAllSenderParams();
      this.startStats();
      return;
    }

    if (type === 'offer') {
      // 我是观看者：应答。信令按「用户」扇出——同一账号的其他连接（如独立观看窗）的 offer
      // 也会送达这里；watch() 会同步建好 receiver，因此没有对应 receiver 的 offer 就不是给我的，忽略。
      const key = cid || this.cidOfPeer.get(from) || '';
      const pc = key ? this.receivers.get(key) : undefined;
      if (!pc) return;
      await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: data.sdp! }));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.signalSender?.(from, roomId, { type: 'answer', cid: key || undefined, sdp: answer.sdp });
      return;
    }

    if (type === 'answer') {
      // 我是共享者
      const key = cid || ([...this.peerOfCid].find(([, peer]) => peer === from)?.[0] ?? '');
      const pc = key ? this.senders.get(key) : undefined;
      if (!pc) return;
      await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: data.sdp! }));
      return;
    }

    if (type === 'candidate') {
      const key = cid || ([...this.peerOfCid].find(([, peer]) => peer === from)?.[0] ?? '');
      const pc = (key ? this.senders.get(key) : undefined) ?? (key ? this.receivers.get(key) : undefined);
      if (!pc || !data.candidate) return;
      try {
        await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      } catch {
        // 候选早于远端描述到达，忽略
      }
    }
  }

  /** 停止我的共享：关本地流 + 所有面向观看者的 sender 连接（不影响我在看别人的共享） */
  stopLocal(): void {
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
    for (const cid of [...this.senders.keys()]) this.dropConnection(cid);
    this.adapt = 1;
    this.maybeStopStats();
    const cb = this.onSelfStop;
    this.onSelfStop = null;
    cb?.();
  }

  /** 完全停止：本地流 + 所有连接（退出/切号/离开房间时调用） */
  stopAll(): void {
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
    for (const cid of [...this.senders.keys(), ...this.receivers.keys()]) this.dropConnection(cid);
    this.onSelfStop = null;
    this.adapt = 1;
    this.maybeStopStats();
  }

  /** 释放我作为观看者的某一路（不发 bye） */
  private dropReceiver(cid: string): void {
    this.receivers.get(cid)?.close();
    this.receivers.delete(cid);
    const peer = this.peerOfCid.get(cid);
    if (peer && this.cidOfPeer.get(peer) === cid) this.cidOfPeer.delete(peer);
    this.peerOfCid.delete(cid);
    this.roomOfCid.delete(cid);
    this.clearMeta(cid);
    this.maybeStopStats();
  }

  /** 按 cid 释放任意一侧连接与映射 */
  private dropConnection(cid: string): void {
    this.senders.get(cid)?.close();
    this.senders.delete(cid);
    const peer = this.peerOfCid.get(cid);
    this.receivers.get(cid)?.close();
    this.receivers.delete(cid);
    if (peer && this.cidOfPeer.get(peer) === cid) this.cidOfPeer.delete(peer);
    this.peerOfCid.delete(cid);
    this.roomOfCid.delete(cid);
    this.clearMeta(cid);
    // 观看人数减少 → 剩余各路可以多分一点带宽
    this.applyAllSenderParams();
    this.maybeStopStats();
  }

  private clearMeta(cid: string): void {
    const m = this.meta.get(cid);
    if (m?.restartTimer) clearTimeout(m.restartTimer);
    this.meta.delete(cid);
  }

  private ensureMeta(cid: string): PeerMeta {
    let m = this.meta.get(cid);
    if (!m) {
      m = {
        lastBytes: 0,
        lastTs: 0,
        kbps: 0,
        fps: 0,
        width: 0,
        height: 0,
        rttMs: 0,
        lossPct: 0,
        transport: '',
        restartTimer: null,
        restarts: 0,
      };
      this.meta.set(cid, m);
    }
    return m;
  }

  /** 按当前档位与分摊结果，给某条 sender 的每路轨道设置编码参数 */
  private applySenderParams(sender: RTCRtpSender, kind: string): void {
    const preset = QUALITY_PRESETS[this.getEffectiveQuality()];
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
      const enc = { ...params.encodings[0] };
      if (kind === 'audio') {
        // 系统声音默认 Opus 码率偏低，显式提到 128k，音乐/游戏音效不至于糊
        enc.maxBitrate = 128_000;
      } else {
        enc.maxBitrate = this.getTargetBps();
        enc.scaleResolutionDownBy = preset.scale;
      }
      params.encodings = [enc];
      if (kind === 'video') {
        (params as RTCRtpSendParameters & { degradationPreference?: string }).degradationPreference = preset.degradation;
      }
      sender.setParameters(params).then(
        () => {
          this.lastParamError = null;
        },
        (err: unknown) => {
          // 个别 Chromium/WebView2 版本会拒绝同时修改 degradationPreference 或
          // scaleResolutionDownBy（InvalidModificationError），导致整次下发被丢弃、
          // 表现为「切档位没反应」。这里退回只改码率，保证档位切换至少生效一半。
          this.lastParamError = String((err as Error)?.name ?? err);
          try {
            const fallback = sender.getParameters();
            if (!fallback.encodings || fallback.encodings.length === 0) fallback.encodings = [{}];
            fallback.encodings = [{ ...fallback.encodings[0], maxBitrate: enc.maxBitrate }];
            sender.setParameters(fallback).catch(() => undefined);
          } catch {
            /* 忽略 */
          }
        },
      );
    } catch (e) {
      this.lastParamError = String((e as Error)?.name ?? e);
    }
  }

  /** 重算所有 sender 的码率（观看人数 / 档位 / 预算 / 自适应变化时调用） */
  private applyAllSenderParams(): void {
    for (const pc of this.senders.values()) {
      for (const sender of pc.getSenders()) {
        const kind = sender.track?.kind;
        if (!kind) continue;
        this.applySenderParams(sender, kind);
      }
    }
  }

  private startStats(): void {
    if (this.statsTimer) return;
    this.statsTimer = setInterval(() => void this.sampleStats(), 2000);
  }

  private maybeStopStats(): void {
    if (this.statsTimer && this.senders.size === 0 && this.receivers.size === 0) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
  }

  /** 采样所有连接的统计，并按丢包/延迟做码率自适应 */
  private async sampleStats(): Promise<void> {
    const now = performance.now();
    let worstLoss = 0;
    let worstRtt = 0;
    for (const [cid, pc] of [...this.senders, ...this.receivers]) {
      const m = this.ensureMeta(cid);
      let bytes = 0;
      let fps = 0;
      let width = 0;
      let height = 0;
      let rtt = 0;
      let lost = 0;
      let sent = 0;
      try {
        const stats = await pc.getStats();
        stats.forEach((r) => {
          const rr = r as Record<string, unknown>;
          const isSender = this.senders.has(cid);
          if (isSender && rr.type === 'outbound-rtp' && rr.kind === 'video') {
            bytes = Number(rr.bytesSent ?? 0);
            fps = Number(rr.framesPerSecond ?? 0);
            width = Number(rr.frameWidth ?? 0);
            height = Number(rr.frameHeight ?? 0);
          } else if (!isSender && rr.type === 'inbound-rtp' && rr.kind === 'video') {
            bytes = Number(rr.bytesReceived ?? 0);
            fps = Number(rr.framesPerSecond ?? 0);
            width = Number(rr.frameWidth ?? 0);
            height = Number(rr.frameHeight ?? 0);
            lost = Number(rr.packetsLost ?? 0);
            sent = Number(rr.packetsReceived ?? 0) + lost;
          } else if (rr.type === 'remote-inbound-rtp' && rr.kind === 'video') {
            // 共享端可见的「对端反馈」：丢包与往返延迟
            lost = Number(rr.packetsLost ?? 0);
            sent = Number(rr.packetsSent ?? 0) + lost;
            rtt = Math.round(Number(rr.roundTripTime ?? 0) * 1000);
          } else if (rr.type === 'candidate-pair' && (rr.selected === true || (rr.state === 'succeeded' && rr.nominated === true))) {
            const local = (stats.get(rr.localCandidateId as string) as Record<string, unknown> | undefined)?.candidateType ?? '';
            const remote = (stats.get(rr.remoteCandidateId as string) as Record<string, unknown> | undefined)?.candidateType ?? '';
            if (local || remote) m.transport = `${local}↔${remote}`;
          }
        });
      } catch {
        continue;
      }
      if (m.lastTs > 0 && now > m.lastTs) {
        const deltaBytes = Math.max(0, bytes - m.lastBytes);
        m.kbps = Math.round((deltaBytes * 8) / (now - m.lastTs));
      }
      m.lastBytes = bytes;
      m.lastTs = now;
      if (fps) m.fps = fps;
      if (width) m.width = width;
      if (height) m.height = height;
      if (rtt) m.rttMs = rtt;
      if (sent > 0) m.lossPct = Math.min(100, Math.round((lost / sent) * 1000) / 10);
      if (this.senders.has(cid)) {
        worstLoss = Math.max(worstLoss, m.lossPct);
        worstRtt = Math.max(worstRtt, m.rttMs);
      }
    }
    // 自适应：只由共享端驱动（观看端改了也没用）
    if (this.senders.size > 0) this.adaptBitrate(worstLoss, worstRtt, now);
  }

  private adaptBitrate(lossPct: number, rttMs: number, now: number): void {
    // 两次调整至少间隔 4s，避免抖动
    if (now - this.lastAdaptAt < 4000) return;
    const before = this.adapt;
    if (lossPct > 5 || rttMs > 400) {
      this.adapt = Math.max(ADAPT_FLOOR, this.adapt * 0.75);
    } else if (lossPct < 1 && rttMs < 200) {
      this.adapt = Math.min(1, this.adapt * 1.15);
    }
    if (Math.abs(this.adapt - before) > 0.01) {
      this.lastAdaptAt = now;
      this.applyAllSenderParams();
    }
  }

  /** ICE 断线自愈：disconnected 等 2s 再重启，failed 立即重启；退避 2/4/8s，最多 4 次 */
  private scheduleIceRestart(cid: string, pc: RTCPeerConnection, delayMs: number): void {
    const m = this.ensureMeta(cid);
    if (m.restartTimer) return;
    if (m.restarts >= 4) return;
    m.restartTimer = setTimeout(() => {
      m.restartTimer = null;
      const state = pc.iceConnectionState;
      if (state === 'connected' || state === 'completed' || state === 'closed') return;
      m.restarts += 1;
      try {
        pc.restartIce();
      } catch {
        /* 不支持则等下一次尝试 */
      }
      const peer = this.peerOfCid.get(cid) ?? '';
      this.onIceState?.(peer, `restarting#${m.restarts}`);
      // 下一次重启用更长的退避
      if (m.restarts < 4) this.scheduleIceRestart(cid, pc, Math.min(8000, delayMs * 2));
    }, delayMs);
  }

  private createPeerConnection(cid: string, isSender: boolean): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: iceServers(this.extraIceServers) });
    const room = this.roomOfCid.get(cid) ?? '';
    const peer = this.peerOfCid.get(cid) ?? '';
    this.ensureMeta(cid);
    pc.onicecandidate = (ev) => {
      if (ev.candidate) this.signalSender?.(peer, room, { type: 'candidate', cid, candidate: ev.candidate.toJSON() });
    };
    pc.ontrack = (ev) => {
      if (!isSender) {
        const [stream] = ev.streams;
        if (stream) this.onRemoteStream?.(peer, stream);
      }
    };
    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      const m = this.ensureMeta(cid);
      if (state === 'connected' || state === 'completed') {
        m.restarts = 0;
        if (m.restartTimer) {
          clearTimeout(m.restartTimer);
          m.restartTimer = null;
        }
        this.onIceState?.(peer, `${state}${m.transport ? `·${m.transport}` : ''}`);
      } else if (state === 'disconnected') {
        this.onIceState?.(peer, state);
        this.scheduleIceRestart(cid, pc, 2000);
      } else if (state === 'failed') {
        this.onIceState?.(peer, state);
        this.scheduleIceRestart(cid, pc, 500);
      } else if (state === 'closed') {
        this.onIceState?.(peer, state);
      }
    };
    pc.onnegotiationneeded = async () => {
      if (!isSender) return;
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        this.signalSender?.(peer, room, { type: 'offer', cid, sdp: offer.sdp });
      } catch (e) {
        console.error('screen share offer failed:', e);
      }
    };
    return pc;
  }
}
