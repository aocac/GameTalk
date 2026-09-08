/**
 * 提示音：WebAudio 合成，零音频资源、可实时调音量。
 *
 * 音色设计（v0.8 重做）：
 * - 每个音都是「正弦主音 + 轻微失谐副音」的叠加，配 8ms 起音与指数衰减，
 *   再过一道低通滤掉刺耳的高频毛刺——上一版纯八度泛音（3135Hz）听起来像系统蜂鸣。
 * - 主频落在 880–1600Hz：能穿透游戏音效，又不至于像报警器。
 * - 事件分级，音量层级分明：收到消息 > @我 > 发送确认 > 错误。
 * - 音量由设置里的滑块控制；屏幕共享带音频时会被外部静音（避免自己的提示音进共享流）。
 */

import { useSettings } from './settings';

let ctx: AudioContext | null = null;
/** 屏幕共享带系统音频时置真：本应用的提示音不进共享流（WebView2 无法做进程级隔离） */
let externalMute = false;

export function setExternalMute(muted: boolean): void {
  externalMute = muted;
}

export function isExternallyMuted(): boolean {
  return externalMute;
}

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

interface Tone {
  /** 频率（Hz） */
  freq: number;
  /** 相对本次播放起点的延迟（秒） */
  at: number;
  /** 衰减时长（秒） */
  dur: number;
  /** 峰值增益（0-1，最终还会乘以音量设置） */
  gain: number;
  /** 副音失谐量（音分），用于做厚度 */
  detune?: number;
  type?: OscillatorType;
}

/** 统一的发声管线：主音 + 失谐副音 → 低通 → 输出 */
function playTones(tones: Tone[], lowpass = 3200): void {
  const ac = getCtx();
  if (!ac) return;
  const vol = Math.min(1, Math.max(0, (useSettings.getState().soundVolume ?? 70) / 100));
  if (vol <= 0) return;
  const now = ac.currentTime;

  const lp = ac.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = lowpass;
  lp.Q.value = 0.6;
  lp.connect(ac.destination);

  for (const t of tones) {
    const start = now + t.at;
    const shape = (osc: OscillatorNode, gainValue: number) => {
      const g = ac.createGain();
      // 8ms 起音后指数衰减：既有"点击感"又不会爆音
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gainValue * vol), start + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, start + t.dur);
      osc.connect(g);
      g.connect(lp);
      osc.start(start);
      osc.stop(start + t.dur + 0.03);
      return g;
    };
    const osc = ac.createOscillator();
    osc.type = t.type ?? 'sine';
    osc.frequency.value = t.freq;
    shape(osc, t.gain);
    if (t.detune) {
      const osc2 = ac.createOscillator();
      osc2.type = t.type ?? 'sine';
      osc2.frequency.value = t.freq;
      osc2.detune.value = t.detune;
      shape(osc2, t.gain * 0.4);
    }
  }
}

function ready(enabled: boolean): boolean {
  return enabled && !externalMute;
}

/** 收到消息：柔和的两声上行（E6 → A6），像「叮—咚」 */
export function playMessageSound(enabled: boolean): void {
  if (!ready(enabled)) return;
  playTones([
    { freq: 1318.5, at: 0, dur: 0.18, gain: 0.1, detune: 6 },
    { freq: 1760, at: 0.085, dur: 0.24, gain: 0.085, detune: -5 },
  ]);
}

/** 被 @ 到：三声更亮的上行，明显区别于普通消息但同样克制 */
export function playMentionSound(enabled: boolean): void {
  if (!ready(enabled)) return;
  playTones([
    { freq: 1318.5, at: 0, dur: 0.12, gain: 0.085, detune: 5 },
    { freq: 1661.2, at: 0.075, dur: 0.12, gain: 0.08, detune: 5 },
    { freq: 2093, at: 0.15, dur: 0.2, gain: 0.07, detune: -4 },
  ]);
}

/** 发送确认：极轻的单音短点，只用来确认「发出去了」 */
export function playSendSound(enabled: boolean): void {
  if (!ready(enabled)) return;
  playTones([{ freq: 1174.7, at: 0, dur: 0.09, gain: 0.05, detune: 4 }], 2600);
}

/** 操作失败：下行小三度，提示但不惊吓 */
export function playErrorSound(enabled: boolean): void {
  if (!ready(enabled)) return;
  playTones([
    { freq: 784, at: 0, dur: 0.16, gain: 0.075, detune: 5 },
    { freq: 622.3, at: 0.09, dur: 0.26, gain: 0.07, detune: -5 },
  ]);
}

/** 试听（设置页用）：忽略外部静音，只受音量与开关影响 */
export function previewSound(kind: 'message' | 'mention' | 'send' | 'error'): void {
  const wasMuted = externalMute;
  externalMute = false;
  try {
    if (kind === 'message') playMessageSound(true);
    else if (kind === 'mention') playMentionSound(true);
    else if (kind === 'send') playSendSound(true);
    else playErrorSound(true);
  } finally {
    externalMute = wasMuted;
  }
}
