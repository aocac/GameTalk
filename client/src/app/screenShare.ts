/**
 * 屏幕共享：P2P WebRTC，请求/应答式 mesh（支持多人同时共享 + 晚加入）。
 * - 共享者：getDisplayMedia 取流后只广播「我在共享」，不预先给任何人建连接。
 * - 观看者：点「观看」时向共享者发 `request`；共享者收到后为该观看者建 sender 连接并回 offer。
 * - 一个客户端可同时是共享者（senders: 我→各观看者）和观看者（receivers: 各共享者→我）。
 * - SDP / ICE 经服务端 screen:signal 定向透传，媒体流不经服务器。STUN 用国内公共节点；无 TURN 兜底。
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

function iceServers(): RTCIceServer[] {
  return cachedTurn ? [...STUN_SERVERS, cachedTurn] : STUN_SERVERS;
}

// 模块加载即预热 TURN 凭据（用户点共享/观看时通常已就绪）
ensureTurnCredential();

export type SignalSender = (to: string, roomId: string, data: unknown) => void;

type SignalPayload = {
  type: 'request' | 'offer' | 'answer' | 'candidate';
  sdp?: string;
  candidate?: RTCIceCandidateInit;
};

export class ScreenShareManager {
  private localStream: MediaStream | null = null;
  /** 我作为共享者：viewerId -> sender pc */
  private senders = new Map<string, RTCPeerConnection>();
  /** 我作为观看者：sharerId -> receiver pc */
  private receivers = new Map<string, RTCPeerConnection>();
  /** 每个对端所属房间（回发信令时带上正确的 roomId） */
  private roomOf = new Map<string, string>();
  private signalSender: SignalSender | null = null;
  private onRemoteStream: ((sharerId: string, stream: MediaStream) => void) | null = null;
  private onSelfStop: (() => void) | null = null;
  private onIceState: ((peerId: string, state: string) => void) | null = null;

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

  /** 发起共享：仅取屏幕流。用户取消选择器时静默返回（isSharing 保持 false）。 */
  async start(roomId: string, signalSender: SignalSender, onSelfStop: () => void): Promise<void> {
    this.signalSender = signalSender;
    this.onSelfStop = onSelfStop;
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error('当前运行环境不支持屏幕捕获（WebView2 版本过旧，或非安全上下文）');
    }
    if (this.localStream) return; // 已在共享，幂等
    try {
      this.localStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
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
    this.roomOf.set('__self__', roomId);
    this.localStream.getVideoTracks()[0]?.addEventListener('ended', () => this.stopLocal());
  }

  /** 我作为观看者，主动请求观看 sharerId 的共享（晚加入靠这个触发共享者重新 offer） */
  watch(sharerId: string, roomId: string): void {
    this.signalSender ??= null;
    this.roomOf.set(sharerId, roomId);
    if (this.receivers.has(sharerId)) return;
    const pc = this.createPeerConnection(sharerId, false);
    this.receivers.set(sharerId, pc);
    this.signalSender?.(sharerId, roomId, { type: 'request' });
  }

  /** 停止观看某个共享者 */
  stopWatching(sharerId: string): void {
    this.receivers.get(sharerId)?.close();
    this.receivers.delete(sharerId);
    this.roomOf.delete(sharerId);
  }

  /** 处理收到的信令（from 为对端用户 ID，roomId 为该共享所属房间） */
  async handleSignal(from: string, roomId: string, raw: unknown): Promise<void> {
    const data = raw as SignalPayload;
    const type = data?.type;
    this.roomOf.set(from, roomId);

    if (type === 'request') {
      // 我是共享者：为该观看者建 sender 连接并 addTrack（addTrack 触发 onnegotiationneeded → offer）
      if (!this.localStream) return;
      const existing = this.senders.get(from);
      if (existing) {
        existing.close();
      }
      const pc = this.createPeerConnection(from, true);
      this.senders.set(from, pc);
      for (const track of this.localStream.getTracks()) {
        const sender = pc.addTrack(track, this.localStream);
        // 限制上行码率，走中继时也不至于吃满带宽（约 1.2Mbps）
        try {
          const params = sender.getParameters();
          params.encodings = [{ ...(params.encodings?.[0] ?? {}), maxBitrate: 1_200_000 }];
          void sender.setParameters(params);
        } catch {
          /* 某些环境不支持动态 setParameters，忽略 */
        }
      }
      return;
    }
    if (type === 'offer') {
      // 我是观看者：应答
      let pc = this.receivers.get(from);
      if (!pc) {
        pc = this.createPeerConnection(from, false);
        this.receivers.set(from, pc);
      }
      await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: data.sdp! }));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.signalSender?.(from, roomId, { type: 'answer', sdp: answer.sdp });
      return;
    }
    if (type === 'answer') {
      // 我是共享者
      const pc = this.senders.get(from);
      if (!pc) return;
      await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: data.sdp! }));
      return;
    }
    if (type === 'candidate') {
      const pc = this.senders.get(from) ?? this.receivers.get(from);
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
    this.senders.forEach((pc) => pc.close());
    this.senders.clear();
    const cb = this.onSelfStop;
    this.onSelfStop = null;
    cb?.();
  }

  /** 完全停止：本地流 + 所有连接（退出/切号/离开房间时调用） */
  stopAll(): void {
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
    this.senders.forEach((pc) => pc.close());
    this.senders.clear();
    this.receivers.forEach((pc) => pc.close());
    this.receivers.clear();
    this.roomOf.clear();
    this.onSelfStop = null;
  }

  private createPeerConnection(peerId: string, isSender: boolean): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: iceServers() });
    const room = this.roomOf.get(peerId) ?? '';
    pc.onicecandidate = (ev) => {
      if (ev.candidate) this.signalSender?.(peerId, room, { type: 'candidate', candidate: ev.candidate.toJSON() });
    };
    pc.ontrack = (ev) => {
      if (!isSender) {
        const [stream] = ev.streams;
        if (stream) this.onRemoteStream?.(peerId, stream);
      }
    };
    pc.oniceconnectionstatechange = () => {
      this.onIceState?.(peerId, pc.iceConnectionState);
    };
    pc.onnegotiationneeded = async () => {
      if (!isSender) return;
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        this.signalSender?.(peerId, room, { type: 'offer', sdp: offer.sdp });
      } catch (e) {
        console.error('screen share offer failed:', e);
      }
    };
    return pc;
  }
}
