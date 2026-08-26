import { hash, verify } from '@node-rs/argon2';

export async function hashPassword(password: string): Promise<string> {
  return hash(password);
}

export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  return verify(passwordHash, password);
}
