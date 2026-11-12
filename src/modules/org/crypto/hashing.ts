import { createHash, createHmac, randomBytes } from 'node:crypto';
import { domainToASCII } from 'node:url';

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Trimmed, Unicode NFC, lowercased, domain in ASCII (punycode). Gmail dots
 * and plus tags are kept: they are distinct addresses for other providers.
 */
export function normalizeEmail(email: string): string {
  const lower = email.trim().normalize('NFC').toLowerCase();
  const at = lower.lastIndexOf('@');
  if (at < 0) return lower;
  // '' for a domain that is not a valid hostname: keep it as given
  const domain = domainToASCII(lower.slice(at + 1)) || lower.slice(at + 1);
  return `${lower.slice(0, at)}@${domain}`;
}

/** Keyed lookup hash for emails (amendment A14); key is config `org.emailHashKey`, decoded from base64. */
export function hmacEmail(email: string, key: Buffer): string {
  return createHmac('sha256', key).update(normalizeEmail(email)).digest('hex');
}

export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
