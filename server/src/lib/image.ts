// 头像 data URL 校验：格式、大小、magic bytes
const MAX_AVATAR_BYTES = 3 * 1024 * 1024; // 3MB

const MAGIC: Array<{ bytes: number[]; mime: string }> = [
  { bytes: [0x89, 0x50, 0x4e, 0x47], mime: 'image/png' },
  { bytes: [0xff, 0xd8, 0xff], mime: 'image/jpeg' },
  { bytes: [0x52, 0x49, 0x46, 0x46], mime: 'image/webp' }, // RIFF....WEBP
  { bytes: [0x47, 0x49, 0x46, 0x38], mime: 'image/gif' },
];

export interface AvatarResult {
  ok: boolean;
  dataUrl?: string;
  error?: string;
}

/**
 * 解析并校验头像 data URL。
 * 返回 { ok: true, dataUrl } 或 { ok: false, error }。
 */
export function validateAvatarDataUrl(input: unknown): AvatarResult {
  if (typeof input !== 'string') {
    return { ok: false, error: 'invalid_avatar' };
  }
  const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/s.exec(input);
  if (!m) {
    return { ok: false, error: 'invalid_avatar_type' };
  }
  const mime = m[1];
  const b64 = m[2];
  let buf: Buffer;
  try {
    buf = Buffer.from(b64, 'base64');
  } catch {
    return { ok: false, error: 'invalid_avatar_encoding' };
  }
  if (buf.length === 0 || buf.length > MAX_AVATAR_BYTES) {
    return { ok: false, error: 'avatar_too_large' };
  }
  // magic bytes 校验（webp 需额外检查 "WEBP" 在第 8-11 字节）
  const matched = MAGIC.some(({ bytes, mime: mm }) => {
    if (mm === 'image/webp') {
      return (
        buf.length >= 12 &&
        bytes.every((b, i) => buf[i] === b) &&
        buf.toString('ascii', 8, 12) === 'WEBP'
      );
    }
    return buf.length >= bytes.length && bytes.every((b, i) => buf[i] === b);
  });
  if (!matched) {
    return { ok: false, error: 'invalid_avatar_content' };
  }
  // 归一化：按实际校验的 mime 输出
  return { ok: true, dataUrl: `data:${mime};base64,${b64}` };
}
