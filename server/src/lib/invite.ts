// 邀请码：8 位，去除易混淆字符（0/O/1/I/L）
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

export function generateInviteCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
}

/** 邀请链接长码：16 位，熵远高于房间邀请码（链接可能脱离房间语境公开传播，需防猜测） */
export function generateInviteLinkCode(): string {
  let code = '';
  for (let i = 0; i < 16; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
}
