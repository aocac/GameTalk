/**
 * 屏幕共享：P2P WebRTC，请求/应答式，按连接 ID（cid）多路复用。
 * - 共享者：getDisplayMedia 取流后只广播「我在共享」，观看端发 request 才为它建连接（晚加入友好）。
 * - 每条观看连接用独立的 cid 标识：同一用户多台设备 / 多个窗口同时观看互不干扰。
 * - 一个客户端可同时是共享者（senders）和观看者（receivers）。
 * - SDP / ICE 经服务端 screen:signal 定向透传，媒体流不经服务器。
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

function iceServers(extra: RTCIceServer[] = []): RTCIceServer[] {
  return [...extra, ...STUN_SERVERS, ...(cachedTurn ? [cachedTurn] : [])];
}

// 模块加载即预热 TURN 凭据（用户点共享/观看时通常已就绪）
ensureTurnCredential();

export type SignalSender = (to: string, roomId: string, data: unknown) => void;

type SignalPayload = {
  type: 'request' | 'offer' | 'answer' | 'candidate' | 'bye';
  /** 连接 ID：同一用户的多端 / 多窗口各自一条观看连接 */
  cid?: string;
  sdp?: string;
  candidate?: RTCIceCandidateInit;
};

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
  private signalSender: SignalSender | null = null;
  private onRemoteStream: ((sharerId: string, stream: MediaStream) => void) | null = null;
  private onSelfStop: (() => void) | null = null;
  private onIceState: ((peerId: string, state: string) => void) | null = null;
  /** 服务端 /api/turn 签发的自建 coturn 凭据（首选 TURN；OpenRelay 兜底在其后） */
  private extraIceServers: RTCIceServer[] = [];

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

  /** 发起共享：仅取屏幕流。用户取消选择器时静默返回（isSharing 保持 false）。 */
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
        audio: false,
      });
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
    this.roomOfCid.set('__self__', roomId);
    this.localStream.getVideoTracks()[0]?.addEventListener('ended', () => this.stopLocal());
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
  }

  /** 停止观看某个共享者：释放本地连接并通知共享者释放对应的那一路 */
  stopWatching(sharerId: string): void {
    const cid = this.cidOfPeer.get(sharerId);
    if (!cid) return;
    const roomId = this.roomOfCid.get(cid) ?? '';
    this.signalSender?.(sharerId, roomId, { type: 'bye', cid });
    this.dropReceiver(cid);
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
      if (existing) existing.close();
      this.senders.set(key, this.createPeerConnection(key, true));
      for (const track of this.localStream.getTracks()) {
        const sender = this.senders.get(key)!.addTrack(track, this.localStream);
        // 码率上限 + 带宽不足时允许降分辨率保帧率（屏幕默认「保分辨率」会疯狂掉帧）
        try {
          const params = sender.getParameters();
          params.encodings = [{ ...(params.encodings?.[0] ?? {}), maxBitrate: 4_000_000 }];
          (params as RTCRtpSendParameters & { degradationPreference?: string }).degradationPreference = 'balanced';
          void sender.setParameters(params);
        } catch {
          /* 某些环境不支持动态 setParameters，忽略 */
        }
      }
      return;
    }

    if (type === 'offer') {
      // 我是观看者：应答（cid 缺省时按共享者回退匹配）
      const key = cid || this.cidOfPeer.get(from) || '';
      let pc = key ? this.receivers.get(key) : undefined;
      if (!pc) {
        const fallbackKey = key || `legacy-${from}`;
        this.peerOfCid.set(fallbackKey, from);
        this.roomOfCid.set(fallbackKey, roomId);
        pc = this.createPeerConnection(fallbackKey, false);
        this.receivers.set(fallbackKey, pc);
      }
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
  }

  /** 释放我作为观看者的某一路（不发 bye） */
  private dropReceiver(cid: string): void {
    this.receivers.get(cid)?.close();
    this.receivers.delete(cid);
    const peer = this.peerOfCid.get(cid);
    if (peer && this.cidOfPeer.get(peer) === cid) this.cidOfPeer.delete(peer);
    this.peerOfCid.delete(cid);
    this.roomOfCid.delete(cid);
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
  }

  private createPeerConnection(cid: string, isSender: boolean): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: iceServers(this.extraIceServers) });
    const room = this.roomOfCid.get(cid) ?? '';
    const peer = this.peerOfCid.get(cid) ?? '';
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
      this.onIceState?.(peer, pc.iceConnectionState);
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
