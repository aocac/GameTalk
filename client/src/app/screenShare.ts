/**
 * 屏幕共享：P2P WebRTC，请求/应答式 mesh（支持多人同时共享 + 晚加入）。
 * - 共享者：getDisplayMedia 取流后只广播「我在共享」，不预先给任何人建连接。
 * - 观看者：点「观看」时向共享者发 `request`；共享者收到后为该观看者建 sender 连接并回 offer。
 * - 一个客户端可同时是共享者（senders: 我→各观看者）和观看者（receivers: 各共享者→我）。
 * - SDP / ICE 经服务端 screen:signal 定向透传，媒体流不经服务器。STUN 用国内公共节点；无 TURN 兜底。
 */

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.qq.com:3478' },
  { urls: 'stun:stun.chat.bilibili.com:3478' },
  { urls: 'stun:stun.aliyun.com:3478' },
  { urls: 'stun:stun.miwifi.com:3478' },
];

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

  get isSharing(): boolean {
    return this.localStream !== null;
  }

  setSignalSender(fn: SignalSender): void {
    this.signalSender = fn;
  }

  setRemoteStreamHandler(fn: (sharerId: string, stream: MediaStream) => void): void {
    this.onRemoteStream = fn;
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
      for (const track of this.localStream.getTracks()) pc.addTrack(track, this.localStream);
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
    const pc = new RTCPeerConnection({ iceServers: DEFAULT_ICE_SERVERS });
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
