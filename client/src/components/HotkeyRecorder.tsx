import { useEffect, useRef, useState } from 'react';
import { formatHotkeyCombo } from '../app/platform';

/**
 * 快捷键录制输入框：聚焦后进入录制态，按下组合键即时显示并保存。
 * macOS 的 Command 录成 Command（不是 Super），与 Tauri global-shortcut 一致。
 */
export default function HotkeyRecorder({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [recording, setRecording] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!recording) return;
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const combo = formatHotkeyCombo(e);
      if (combo) {
        setPending(combo);
        setRecording(false);
        onChange(combo);
        inputRef.current?.blur();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [recording, onChange]);

  return (
    <input
      ref={inputRef}
      className="hotkey-input"
      value={recording ? (pending ?? '按下组合键…') : value}
      placeholder="点击后按下组合键"
      readOnly
      onFocus={() => {
        setPending(null);
        setRecording(true);
      }}
      onBlur={() => setRecording(false)}
    />
  );
}
