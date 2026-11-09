import { FieldEncryptionService } from '@/modules/org/crypto/field-encryption.service';
import type { IConfigurationService } from '@/config/configuration.service.interface';

const k = (n: number): string => Buffer.alloc(32, n).toString('base64');
const service = (keys: unknown): FieldEncryptionService =>
  new FieldEncryptionService({
    getOrThrow: () => JSON.stringify(keys),
  } as unknown as IConfigurationService);

describe('FieldEncryptionService', () => {
  const v1 = { current: 'v1', keys: { v1: k(1) } };
  const rotated = { current: 'v2', keys: { v1: k(1), v2: k(2) } };

  it('round-trips and uses a fresh IV', () => {
    const s = service(v1);
    const a = s.encrypt('secret');
    expect(a).toMatch(/^v1:[^:]+:[^:]+$/);
    expect(s.decrypt(a)).toBe('secret');
    expect(s.encrypt('secret')).not.toBe(a);
  });

  it('decrypts data written with the previous key after rotation', () => {
    const blob = service(v1).encrypt('old');
    const s = service(rotated);
    expect(s.decrypt(blob)).toBe('old');
    expect(s.needsRotation(blob)).toBe(true);
    const fresh = s.encrypt('new');
    expect(fresh.startsWith('v2:')).toBe(true);
    expect(s.needsRotation(fresh)).toBe(false);
  });

  it('fails on tampered ciphertext', () => {
    const s = service(v1);
    const [v, iv, ct] = s.encrypt('secret').split(':');
    const buf = Buffer.from(ct, 'base64');
    buf[0] ^= 1;
    expect(() => s.decrypt(`${v}:${iv}:${buf.toString('base64')}`)).toThrow();
  });

  it('fails on unknown key version and malformed blobs', () => {
    const s = service(v1);
    expect(() => s.decrypt(s.encrypt('x').replace('v1:', 'v9:'))).toThrow(
      /key version/,
    );
    expect(() => s.decrypt('garbage')).toThrow();
  });
});
