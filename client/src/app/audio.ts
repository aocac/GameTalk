// WebAudio 合成提示音（v1 无需音频资源文件，零体积、可即时调节）

let ctx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  try {
    if (!ctx) {
      const AC =
        typeof window !== 'undefined' &&
        (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function playNote(ac: AudioContext, freq: number, start: number, dur: number, vol: number, type: OscillatorType): void {
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(vol, start + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  osc.connect(gain);
  gain.connect(ac.destination);
  osc.start(start);
  osc.stop(start + dur + 0.02);
}

/**
 * 收到新消息：柔和圆润的「叮」——主音 C6 + 高八度泛音，短促不刺耳。
 */
export function playMessageSound(enabled: boolean): void {
  if (!enabled) return;
  const ac = getCtx();
  if (!ac) return;
  const now = ac.currentTime;
  playNote(ac, 1046.5, now, 0.24, 0.14, 'sine'); // C6 主音
  playNote(ac, 2093.0, now + 0.004, 0.18, 0.045, 'sine'); // C7 泛音
  playNote(ac, 3135.96, now + 0.008, 0.1, 0.012, 'sine'); // 轻微高频润色
}

/** 发送消息确认音：低促一声 */
export function playSendSound(enabled: boolean): void {
  if (!enabled) return;
  const ac = getCtx();
  if (!ac) return;
  const now = ac.currentTime;
  playNote(ac, 784.0, now, 0.12, 0.09, 'sine'); // G5
  playNote(ac, 1046.5, now + 0.008, 0.1, 0.04, 'sine');
}
