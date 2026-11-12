import { totp } from '@/modules/org/crypto/totp';
import {
  sha256Hex,
  normalizeEmail,
  hmacEmail,
  generateToken,
} from '@/modules/org/crypto/hashing';

// RFC 6238 Appendix B secret (ASCII "12345678901234567890") in base32
const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const at = (s: number): Date => new Date(s * 1000);

describe('totp', () => {
  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ])('RFC 6238 vector T=%i', (t, code) => {
    const result = totp.verify(SECRET, code, at(t), null);
    expect(result).toEqual({ ok: true, step: Math.floor(t / 30) });
  });

  it('rejects a code from a step already used', () => {
    const step = Math.floor(59 / 30);
    expect(totp.verify(SECRET, '287082', at(59), step).ok).toBe(false);
    expect(totp.verify(SECRET, '287082', at(59), step - 1).ok).toBe(true);
  });

  it('accepts +-1 step and rejects +-2 steps', () => {
    expect(totp.verify(SECRET, '287082', at(59 + 30), null).ok).toBe(true);
    expect(totp.verify(SECRET, '287082', at(59 - 30), null).ok).toBe(true);
    expect(totp.verify(SECRET, '287082', at(59 + 60), null).ok).toBe(false);
  });

  it('rejects malformed codes', () => {
    expect(totp.verify(SECRET, '28708', at(59), null).ok).toBe(false);
    expect(totp.verify(SECRET, 'abcdef', at(59), null).ok).toBe(false);
  });

  it('generates a 20-byte base32 secret and an otpauth uri', () => {
    const secret = totp.generateSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    const uri = totp.otpauthUri(secret, 'a@b.c');
    expect(uri).toContain('otpauth://totp/');
    expect(uri).toContain(`secret=${secret}`);
    expect(uri).toContain('issuer=Protofire%20Multisig');
  });
});

describe('hashing', () => {
  const keyA = Buffer.alloc(32, 1);
  const keyB = Buffer.alloc(32, 2);

  it('sha256Hex hashes', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('normalizeEmail trims and lowercases', () => {
    expect(normalizeEmail('  Foo@Bar.COM ')).toBe('foo@bar.com');
  });

  it('normalizeEmail applies NFC and an ASCII (punycode) domain, keeps dots and plus tags', () => {
    // decomposed e + combining acute (NFD) equals the precomposed e-acute (NFC)
    expect(normalizeEmail('Jose\u0301@example.com')).toBe(
      normalizeEmail('Jos\u00e9@example.com'),
    );
    expect(normalizeEmail('Jos\u00e9@example.com')).toBe(
      'jos\u00e9@example.com',
    );
    expect(normalizeEmail('user@B\u00fccher.Example')).toBe(
      'user@xn--bcher-kva.example',
    );
    expect(normalizeEmail('user@xn--bcher-kva.example')).toBe(
      'user@xn--bcher-kva.example',
    );
    expect(normalizeEmail('First.Last+tag@gmail.com')).toBe(
      'first.last+tag@gmail.com',
    );
  });

  it('hmacEmail is case/whitespace-insensitive and key-dependent', () => {
    expect(hmacEmail(' Foo@Bar.com', keyA)).toBe(
      hmacEmail('foo@bar.com ', keyA),
    );
    expect(hmacEmail('foo@bar.com', keyA)).toMatch(/^[0-9a-f]{64}$/);
    expect(hmacEmail('foo@bar.com', keyA)).not.toBe(
      hmacEmail('foo@bar.com', keyB),
    );
  });

  it('generateToken has the right length and charset', () => {
    const t = generateToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateToken(16)).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(generateToken()).not.toBe(t);
  });
});
