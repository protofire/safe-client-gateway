import { createHash, createHmac, randomBytes } from 'node:crypto';

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Keyed lookup hash for emails (amendment A14); key is config `org.emailHashKey`, decoded from base64. */
export function hmacEmail(email: string, key: Buffer): string {
  return createHmac('sha256', key).update(normalizeEmail(email)).digest('hex');
}

export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
