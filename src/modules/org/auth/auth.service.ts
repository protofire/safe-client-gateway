import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { getAddress, verifyMessage, type Address, type Hex } from 'viem';
import {
  generateSiweNonce,
  parseSiweMessage,
  validateSiweMessage,
} from 'viem/siwe';
import { IConfigurationService } from '@/config/configuration.service.interface';
import type { OrgSession } from '@/modules/org/auth/decorators';
import { NonceStore } from '@/modules/org/auth/nonce.store';
import { SecurityEvents } from '@/modules/org/auth/security-events';
import { SessionsRepository } from '@/modules/org/auth/sessions.repository';
import { Clock, type IClock } from '@/modules/org/common/clock';
import { RateLimiter } from '@/modules/org/common/rate-limiter';
import { FieldEncryptionService } from '@/modules/org/crypto/field-encryption.service';
import { ORG_DATA_SOURCE } from '@/modules/org/db/org-data-source';

// spec §8: SIWE verify 10/min per IP. No per-account limit: the account is
// an unauthenticated claim in the message, so it would let anyone lock a
// wallet out, and a signature cannot be brute-forced.
const VERIFY_PER_IP = 10;
const NONCE_PER_IP = 30;
const WINDOW_SECONDS = 60;
const UNIQUE_VIOLATION = '23505';

export type MeDto = {
  user: { id: string };
  identities: Array<
    | { id: string; kind: 'wallet'; walletAddress: string }
    | { id: string; kind: 'oidc'; issuer: string; email: string | null }
  >;
  hasTotp: boolean;
  lastStrongAuthAt: string | null;
};

type Attempt = { message: string; signature: Hex; ip: string };

@Injectable()
export class AuthService {
  private readonly appOrigin: string;
  private readonly appHost: string;
  private readonly nonceTtlSeconds: number;
  private readonly idleTtlSeconds: number;
  private readonly absoluteTtlSeconds: number;

  constructor(
    @InjectDataSource(ORG_DATA_SOURCE) private readonly db: DataSource,
    @Inject(Clock) private readonly clock: IClock,
    @Inject(IConfigurationService) config: IConfigurationService,
    private readonly sessions: SessionsRepository,
    private readonly rateLimiter: RateLimiter,
    private readonly nonces: NonceStore,
    private readonly encryption: FieldEncryptionService,
    private readonly securityEvents: SecurityEvents,
  ) {
    const appUrl = new URL(config.getOrThrow<string>('org.publicAppUrl'));
    this.appOrigin = appUrl.origin;
    this.appHost = appUrl.host;
    this.nonceTtlSeconds = config.getOrThrow<number>('auth.nonceTtlSeconds');
    this.idleTtlSeconds = config.getOrThrow<number>(
      'org.session.idleTtlSeconds',
    );
    this.absoluteTtlSeconds = config.getOrThrow<number>(
      'org.session.absoluteTtlSeconds',
    );
  }

  get sessionMaxAgeSeconds(): number {
    return this.absoluteTtlSeconds;
  }

  async createNonce(ip: string): Promise<{ nonce: string }> {
    await this.limit(`nonce:ip:${ip}`, NONCE_PER_IP);
    const nonce = generateSiweNonce();
    try {
      await this.nonces.issue(nonce, this.nonceTtlSeconds);
    } catch {
      throw new ServiceUnavailableException('Nonce storage unavailable');
    }
    return { nonce };
  }

  /** First sign-in creates the user and its wallet identity. */
  async signInWithSiwe(
    attempt: Attempt & { userAgent: string | null },
  ): Promise<{ userId: string; token: string }> {
    const address = await this.verifySiwe(attempt);
    const userId = await this.findOrCreateWalletUser(address);
    const [user] = await this.db.query(
      `SELECT status FROM users WHERE id = $1`,
      [userId],
    );
    if (user?.status !== 'active') throw invalidSiwe();
    // other sessions of the user stay valid: several devices are allowed
    // a wallet signature is the strong factor (spec §5)
    const { token } = await this.sessions.create({
      userId,
      amr: ['siwe'],
      strong: true,
      now: this.clock.now(),
      idleTtlSeconds: this.idleTtlSeconds,
      absoluteTtlSeconds: this.absoluteTtlSeconds,
      userAgent: attempt.userAgent,
    });
    return { userId, token };
  }

  /** Only a wallet already linked to the session user counts (amendment A5). */
  async stepUpWithSiwe(session: OrgSession, attempt: Attempt): Promise<void> {
    const address = await this.verifySiwe(attempt);
    const [identity] = await this.db.query(
      `SELECT user_id AS "userId" FROM identities
       WHERE kind = 'wallet' AND wallet_address = $1`,
      [address],
    );
    if (identity?.userId !== session.userId) {
      throw new UnauthorizedException('Wallet is not linked to this account');
    }
    await this.sessions.markStrong(session.sessionId, 'siwe', this.clock.now());
    await this.securityEvents.record(
      session.userId,
      'step_up',
      { method: 'siwe' },
      attempt.ip,
    );
  }

  /** Revokes the session the token names, if any. */
  async logout(token: string | undefined): Promise<void> {
    if (token) await this.sessions.revokeByToken(token, this.clock.now());
  }

  async me(session: OrgSession): Promise<MeDto> {
    const rows: Array<{
      id: string;
      kind: 'wallet' | 'oidc';
      walletAddress: string | null;
      issuer: string | null;
      emailEncrypted: string | null;
    }> = await this.db.query(
      `SELECT id, kind, wallet_address AS "walletAddress", oidc_issuer AS issuer,
         email_encrypted AS "emailEncrypted"
       FROM identities WHERE user_id = $1 ORDER BY created_at, id`,
      [session.userId],
    );
    return {
      user: { id: session.userId },
      identities: rows.map((r) =>
        r.kind === 'wallet'
          ? { id: r.id, kind: 'wallet', walletAddress: r.walletAddress! }
          : {
              id: r.id,
              kind: 'oidc',
              issuer: r.issuer!,
              email: r.emailEncrypted
                ? this.encryption.decrypt(r.emailEncrypted)
                : null,
            },
      ),
      hasTotp: await this.hasConfirmedTotp(session.userId),
      lastStrongAuthAt: session.lastStrongAuthAt?.toISOString() ?? null,
    };
  }

  /** Strong factors the user can step up with; empty means TOTP must be enrolled. */
  async stepUpMethods(userId: string): Promise<Array<'siwe' | 'totp'>> {
    const [{ wallet }] = await this.db.query(
      `SELECT EXISTS (SELECT 1 FROM identities WHERE user_id = $1 AND kind = 'wallet') AS wallet`,
      [userId],
    );
    const methods: Array<'siwe' | 'totp'> = wallet ? ['siwe'] : [];
    if (await this.hasConfirmedTotp(userId)) methods.push('totp');
    return methods;
  }

  private async hasConfirmedTotp(userId: string): Promise<boolean> {
    const [{ totp }] = await this.db.query(
      `SELECT EXISTS (SELECT 1 FROM factors WHERE user_id = $1 AND kind = 'totp'
         AND confirmed_at IS NOT NULL) AS totp`,
      [userId],
    );
    return totp;
  }

  /**
   * EOA signatures only (phase 1). The nonce is consumed with GETDEL, so
   * exactly one concurrent caller wins it.
   */
  private async verifySiwe(attempt: Attempt): Promise<Address> {
    await this.limit(`siwe:ip:${attempt.ip}`, VERIFY_PER_IP);

    let message: ReturnType<typeof parseSiweMessage>;
    try {
      message = parseSiweMessage(attempt.message);
    } catch {
      throw invalidSiwe();
    }
    const { address, uri, nonce, issuedAt, expirationTime, notBefore } =
      message;
    // strict EIP-4361: version 1, checksummed address, parseable dates
    const valid =
      message.version === '1' &&
      address !== undefined &&
      isChecksummed(address) &&
      message.chainId !== undefined &&
      nonce !== undefined &&
      issuedAt !== undefined &&
      [issuedAt, expirationTime, notBefore].every(
        (d) => d === undefined || !Number.isNaN(d.getTime()),
      ) &&
      URL.canParse(uri ?? '') &&
      new URL(uri!).origin === this.appOrigin &&
      validateSiweMessage({
        message,
        domain: this.appHost,
        time: this.clock.now(),
      });
    if (!valid) throw invalidSiwe();

    let signed = false;
    try {
      signed = await verifyMessage({
        address,
        message: attempt.message,
        signature: attempt.signature,
      });
    } catch {
      // malformed signature
    }
    if (!signed) throw invalidSiwe();

    // last, so a rejected request cannot burn someone else's nonce
    if (!(await this.nonces.consume(nonce))) throw invalidSiwe();
    return address;
  }

  private async limit(key: string, limit: number): Promise<void> {
    if (!(await this.rateLimiter.hit(key, limit, WINDOW_SECONDS))) {
      throw new HttpException(
        { statusCode: 429, message: 'Too many attempts' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private async findOrCreateWalletUser(address: Address): Promise<string> {
    const find = async (): Promise<string | undefined> => {
      const [row] = await this.db.query(
        `SELECT user_id AS "userId" FROM identities
         WHERE kind = 'wallet' AND wallet_address = $1`,
        [address],
      );
      return row?.userId;
    };
    const existing = await find();
    if (existing) return existing;
    try {
      return await this.db.transaction(async (em) => {
        const [{ id }] = await em.query(
          `INSERT INTO users DEFAULT VALUES RETURNING id`,
        );
        await em.query(
          `INSERT INTO identities (user_id, kind, wallet_address) VALUES ($1, 'wallet', $2)`,
          [id, address],
        );
        return id as string;
      });
    } catch (error) {
      // a concurrent first sign-in of the same wallet won the unique index
      const winner =
        (error as { code?: string }).code === UNIQUE_VIOLATION
          ? await find()
          : undefined;
      if (winner) return winner;
      throw error;
    }
  }
}

function isChecksummed(address: string): boolean {
  try {
    return getAddress(address) === address;
  } catch {
    return false;
  }
}

function invalidSiwe(): UnauthorizedException {
  return new UnauthorizedException('Invalid SIWE message or signature');
}
