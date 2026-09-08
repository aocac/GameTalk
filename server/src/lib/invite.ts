import { randomInt } from 'node:crypto';

// 邀请码：8 位，去除易混淆字符（0/O/1/I/L）
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

/** 用 CSPRNG 取字符：Math.random() 的进程级状态可从多次输出推测，不适合做邀请凭据 */
function randomCode(length: number): string {
  let code = '';
  for (let i = 0; i < length; i++) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

export function generateInviteCode(): string {
  return randomCode(CODE_LENGTH);
}

/** 邀请链接长码：16 位，熵远高于房间邀请码（链接可能脱离房间语境公开传播，需防猜测） */
export function generateInviteLinkCode(): string {
  return randomCode(16);
}
