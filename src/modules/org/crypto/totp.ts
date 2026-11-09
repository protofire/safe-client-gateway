import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PERIOD_SECONDS = 30;
const DIGITS = 6;
const ISSUER = 'Protofire Multisig';

function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(input: string): Buffer {
  const bytes: Array<number> = [];
  let bits = 0;
  let value = 0;
  for (const ch of input.replace(/=+$/, '').toUpperCase()) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('Invalid base32 secret');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function codeForStep(secret: Buffer, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', secret).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}

export const totp = {
  generateSecret(): string {
    return base32Encode(randomBytes(20));
  },

  /**
   * Pure check. On `ok`, the caller must persist `step` with an atomic
   * `UPDATE ... WHERE last_used_step IS NULL OR last_used_step < step` (A7).
   */
  verify(
    secretBase32: string,
    code: string,
    now: Date,
    lastUsedStep: number | null,
  ): { ok: boolean; step: number } {
    const current = Math.floor(now.getTime() / 1000 / PERIOD_SECONDS);
    if (!/^\d{6}$/.test(code)) return { ok: false, step: current };
    const secret = base32Decode(secretBase32);
    const given = Buffer.from(code);
    let matched: number | null = null;
    for (const step of [current - 1, current, current + 1]) {
      if (step < 0) continue;
      const equal = timingSafeEqual(
        given,
        Buffer.from(codeForStep(secret, step)),
      );
      if (equal && (lastUsedStep === null || step > lastUsedStep)) {
        matched = step;
      }
    }
    return matched === null
      ? { ok: false, step: current }
      : { ok: true, step: matched };
  },

  otpauthUri(secret: string, accountLabel: string): string {
    const issuer = encodeURIComponent(ISSUER);
    return `otpauth://totp/${issuer}:${encodeURIComponent(accountLabel)}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=${DIGITS}&period=${PERIOD_SECONDS}`;
  },
};
