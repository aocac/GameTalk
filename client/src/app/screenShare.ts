/**
 * 屏幕共享：P2P WebRTC  Mesh（1 对 N）。
 * - 共享者调用 getDisplayMedia 拿到本地视频流，然后与每个观看者建立 RTCPeerConnection。
 * - 观看者收到 screen:started 后创建 RTCPeerConnection，等待共享者的 offer。
 * - 所有 SDP / ICE 候选通过 WS 信令走服务端透传，媒体流不经过服务器。
 * - STUN 默认使用国内可达公共节点；生产环境可追加自建 coturn（TURN 中继兜底）。
 */

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.qq.com:3478' },
  { urls: 'stun:stun.chat.bilibili.com:3478' },
  { urls: 'stun:stun.aliyun.com:3478' },
  { urls: 'stun:stun.miwifi.com:3478' },
];

export type SignalSender = (to: string, data: unknown) => void;

interface SignalPayload {
  type: 'offer' | 'answer' | 'candidate';
  sdp?: string;
  candidate?: RTCIceCandidateInit;
}

/** 管理单个房间的一次屏幕共享会话 */
export class ScreenShareManager {
  private localStream: MediaStream | null = null;
  private pcs = new Map<string, RTCPeerConnection>();
  private signalSender: SignalSender | null = null;
  private onRemoteStream: ((stream: MediaStream) => void) | null = null;
  private onStop: (() => void) | null = null;

  get isSharing(): boolean {
    return this.localStream !== null;
  }

  /** 发起共享：获取屏幕流，并向每个房间成员发起 P2P 连接 */
  async start(
    _roomId: string,
    myId: string,
    memberIds: string[],
    signalSender: SignalSender,
    onStop: () => void,
  ): Promise<void> {
    this.signalSender = signalSender;
    this.onStop = onStop;
    try {
      this.localStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    } catch (e) {
      this.reset();
      throw new Error('无法获取屏幕。请确认运行环境支持屏幕捕获（WebView2 需窗口高度 ≥600px）。', { cause: e });
    }
    // 用户点浏览器原生「停止共享」按钮时同步停止
    this.localStream.getVideoTracks()[0]?.addEventListener('ended', () => this.stop());
    for (const memberId of memberIds) {
      if (memberId === myId) continue;
      const pc = this.createPeerConnection(memberId, true);
      this.pcs.set(memberId, pc);
      for (const track of this.localStream.getTracks()) {
        pc.addTrack(track, this.localStream);
      }
    }
  }

  /** 观看他人共享：创建 RTCPeerConnection 等待 offer */
  watch(sharerId: string, signalSender: SignalSender, onRemoteStream: (stream: MediaStream) => void): void {
    this.signalSender = signalSender;
    this.onRemoteStream = onRemoteStream;
    if (!this.pcs.has(sharerId)) {
      this.createPeerConnection(sharerId, false);
    }
  }

  /** 处理 incoming WebRTC 信令 */
  async handleSignal(from: string, raw: unknown): Promise<void> {
    const data = raw as SignalPayload;
    const type = data?.type;
    if (type === 'offer') {
      let pc = this.pcs.get(from);
      if (!pc) {
        pc = this.createPeerConnection(from, false);
        this.pcs.set(from, pc);
      }
      await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: data.sdp! }));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.signalSender?.(from, { type: 'answer', sdp: answer.sdp });
      return;
    }
    if (type === 'answer') {
      const pc = this.pcs.get(from);
      if (!pc) return;
      await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: data.sdp! }));
      return;
    }
    if (type === 'candidate') {
      const pc = this.pcs.get(from);
      if (!pc || !data.candidate) return;
      try {
        await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      } catch {
        // 候选到达时远程描述可能尚未设置，可忽略
      }
    }
  }

  stop(): void {
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
    this.pcs.forEach((pc) => pc.close());
    this.pcs.clear();
    this.signalSender = null;
    this.onRemoteStream = null;
    this.onStop?.();
    this.onStop = null;
  }

  private reset(): void {
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
  }

  private createPeerConnection(peerId: string, isSender: boolean): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: DEFAULT_ICE_SERVERS });
    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        this.signalSender?.(peerId, { type: 'candidate', candidate: ev.candidate.toJSON() });
      }
    };
    pc.ontrack = (ev) => {
      if (!isSender) {
        const [stream] = ev.streams;
        if (stream) this.onRemoteStream?.(stream);
      }
    };
    pc.onnegotiationneeded = async () => {
      if (!isSender) return;
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        this.signalSender?.(peerId, { type: 'offer', sdp: offer.sdp });
      } catch (e) {
        console.error('screen share offer failed:', e);
      }
    };
    this.pcs.set(peerId, pc);
    return pc;
  }
}
