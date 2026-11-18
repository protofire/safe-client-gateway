import { Inject, Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { IConfigurationService } from '@/config/configuration.service.interface';

const IV_BYTES = 12;
const TAG_BYTES = 16;

/** AES-256-GCM; blob format `<keyVersion>:<iv b64>:<ciphertext+tag b64>`. */
@Injectable()
export class FieldEncryptionService {
  private readonly current: string;
  private readonly keys: Map<string, Buffer>;

  constructor(@Inject(IConfigurationService) config: IConfigurationService) {
    // Shape is validated by the org config schema: {"current":"v1","keys":{"v1":"<b64 32 bytes>"}}
    const parsed = JSON.parse(
      config.getOrThrow<string>('org.encryption.keys'),
    ) as { current: string; keys: Record<string, string> };
    this.current = parsed.current;
    this.keys = new Map(
      Object.entries(parsed.keys).map(([v, k]) => [
        v,
        Buffer.from(k, 'base64'),
      ]),
    );
  }

  encrypt(plain: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key(this.current), iv);
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const blob = Buffer.concat([body, cipher.getAuthTag()]);
    return `${this.current}:${iv.toString('base64')}:${blob.toString('base64')}`;
  }

  decrypt(blob: string): string {
    const [version, iv, data, ...rest] = blob.split(':');
    if (!version || !iv || !data || rest.length > 0) {
      throw new Error('Malformed encrypted value');
    }
    const raw = Buffer.from(data, 'base64');
    if (raw.length < TAG_BYTES) throw new Error('Malformed encrypted value');
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.key(version),
      Buffer.from(iv, 'base64'),
    );
    decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
    return Buffer.concat([
      decipher.update(raw.subarray(0, raw.length - TAG_BYTES)),
      decipher.final(),
    ]).toString('utf8');
  }

  private key(version: string): Buffer {
    const key = this.keys.get(version);
    if (!key) throw new Error(`Unknown encryption key version: ${version}`);
    return key;
  }
}
