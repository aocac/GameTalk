// WebAudio 合成提示音（v1 无需音频资源文件，零体积、可即时调节）

let ctx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  try {
    if (!ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

/** 收到新消息的提示音：两声短促的高频"叮咚" */
export function playMessageSound(enabled: boolean): void {
  if (!enabled) return;
  const ac = getCtx();
  if (!ac) return;

  const now = ac.currentTime;
  const notes: Array<[number, number]> = [
    [880, 0.09],
    [1320, 0.12],
  ];

  for (const [freq, dur] of notes) {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.18, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    osc.connect(gain);
    gain.connect(ac.destination);
    osc.start(now);
    osc.stop(now + dur);
  }
}

/** 发送消息的确认音：低促一声 */
export function playSendSound(enabled: boolean): void {
  if (!enabled) return;
  const ac = getCtx();
  if (!ac) return;

  const now = ac.currentTime;
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = 'sine';
  osc.frequency.value = 660;
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(0.12, now + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.07);
  osc.connect(gain);
  gain.connect(ac.destination);
  osc.start(now);
  osc.stop(now + 0.07);
}
