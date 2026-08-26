import { useEffect, useRef, useState } from 'react';

/** e.key → Tauri global-shortcut 可识别的键名 */
function normalizeKey(e: KeyboardEvent): string | null {
  const key = e.key;
  if (key === ' ') return 'Space';
  if (key === 'Escape') return 'Esc';
  if (key === 'Enter') return 'Enter';
  if (key === 'Tab') return 'Tab';
  if (key.startsWith('Arrow')) return key.slice(5); // ArrowUp -> Up
  if (/^[a-zA-Z]$/.test(key)) return key.toUpperCase();
  if (/^[0-9]$/.test(key)) return key;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(key)) return key;
  return null;
}

function formatCombo(e: KeyboardEvent): string | null {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Super');
  const main = normalizeKey(e);
  if (!main) return null; // 纯修饰键或不可识别键：忽略
  parts.push(main);
  return parts.join('+');
}

/**
 * 快捷键录制输入框：聚焦后进入录制态，按下组合键即时显示并保存。
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
      const combo = formatCombo(e);
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
