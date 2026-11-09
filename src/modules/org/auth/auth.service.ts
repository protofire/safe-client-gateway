import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
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
import {
  CacheService,
  ICacheService,
} from '@/datasources/cache/cache.service.interface';
import { CacheDir } from '@/datasources/cache/entities/cache-dir.entity';
import type { OrgSession } from '@/modules/org/auth/decorators';
import { SessionsRepository } from '@/modules/org/auth/sessions.repository';
import { Clock, type IClock } from '@/modules/org/common/clock';
import { RateLimiter } from '@/modules/org/common/rate-limiter';
import { ORG_DATA_SOURCE } from '@/modules/org/db/org-data-source';

// spec §8: SIWE verify 10/min per IP, 5/min per account
const VERIFY_PER_IP = 10;
const VERIFY_PER_ACCOUNT = 5;
const VERIFY_WINDOW_SECONDS = 60;
// EIP-4361: at least 8 alphanumeric characters
const NONCE = /^[A-Za-z0-9]{8,}$/;
const UNIQUE_VIOLATION = '23505';

export type MeDto = {
  user: { id: string };
  identities: Array<
    | { id: string; kind: 'wallet'; walletAddress: string }
    | { id: string; kind: 'oidc'; issuer: string }
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
    @Inject(CacheService) private readonly cache: ICacheService,
    @Inject(Clock) private readonly clock: IClock,
    @Inject(IConfigurationService) config: IConfigurationService,
    private readonly sessions: SessionsRepository,
    private readonly rateLimiter: RateLimiter,
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

  async createNonce(): Promise<{ nonce: string }> {
    const nonce = generateSiweNonce();
    await this.cache.hSet(nonceKey(nonce), '1', this.nonceTtlSeconds, 0);
    return { nonce };
  }

  /** First sign-in creates the user and its wallet identity. */
  async signInWithSiwe(
    attempt: Attempt & { userAgent: string | null },
  ): Promise<{ userId: string; token: string }> {
    const address = await this.verifySiwe(attempt);
    const userId = await this.findOrCreateWalletUser(address);
    // a wallet signature is the strong factor (spec §5)
    const { token } = await this.sessions.create({
      userId,
      amr: ['siwe'],
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
  }

  async logout(session: OrgSession): Promise<void> {
    await this.sessions.revoke(session.sessionId, this.clock.now());
  }

  async me(session: OrgSession): Promise<MeDto> {
    const rows: Array<{
      id: string;
      kind: 'wallet' | 'oidc';
      walletAddress: string | null;
      issuer: string | null;
    }> = await this.db.query(
      `SELECT id, kind, wallet_address AS "walletAddress", oidc_issuer AS issuer
       FROM identities WHERE user_id = $1 ORDER BY created_at, id`,
      [session.userId],
    );
    return {
      user: { id: session.userId },
      // shortcut: OIDC email is not returned until Task 5 wires field decryption
      identities: rows.map((r) =>
        r.kind === 'wallet'
          ? { id: r.id, kind: 'wallet', walletAddress: r.walletAddress! }
          : { id: r.id, kind: 'oidc', issuer: r.issuer! },
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
   * EOA signatures only (phase 1). The nonce is consumed last, after every
   * other check, so a rejected request cannot burn someone else's nonce;
   * UNLINK returning 1 makes exactly one concurrent caller the consumer.
   */
  private async verifySiwe(attempt: Attempt): Promise<Address> {
    await this.limit(`siwe:ip:${attempt.ip}`, VERIFY_PER_IP);

    let message: ReturnType<typeof parseSiweMessage>;
    try {
      message = parseSiweMessage(attempt.message);
    } catch {
      throw invalidSiwe();
    }
    if (!message.address) throw invalidSiwe();
    const address = getAddress(message.address);
    await this.limit(
      `siwe:account:${address.toLowerCase()}`,
      VERIFY_PER_ACCOUNT,
    );

    const valid =
      typeof message.chainId === 'number' &&
      typeof message.nonce === 'string' &&
      NONCE.test(message.nonce) &&
      typeof message.uri === 'string' &&
      URL.canParse(message.uri) &&
      new URL(message.uri).origin === this.appOrigin &&
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

    const consumed = await this.cache.deleteByKey(nonceKey(message.nonce!).key);
    if (consumed !== 1) throw invalidSiwe();
    return address;
  }

  private async limit(key: string, limit: number): Promise<void> {
    if (!(await this.rateLimiter.hit(key, limit, VERIFY_WINDOW_SECONDS))) {
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

function nonceKey(nonce: string): CacheDir {
  return new CacheDir(`auth:nonce:${nonce}`, '');
}

function invalidSiwe(): UnauthorizedException {
  return new UnauthorizedException('Invalid SIWE message or signature');
}
