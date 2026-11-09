import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { IConfigurationService } from '@/config/configuration.service.interface';
import { ORG_REDIS, type OrgRedisClient } from '@/modules/org/auth/nonce.store';
import {
  OidcClient,
  type OidcConnection,
} from '@/modules/org/auth/oidc/oidc.client';
import { SecurityEvents } from '@/modules/org/auth/security-events';
import { SessionsRepository } from '@/modules/org/auth/sessions.repository';
import { Clock, type IClock } from '@/modules/org/common/clock';
import { RateLimiter } from '@/modules/org/common/rate-limiter';
import { FieldEncryptionService } from '@/modules/org/crypto/field-encryption.service';
import {
  generateToken,
  hmacEmail,
  sha256Hex,
} from '@/modules/org/crypto/hashing';
import { ORG_DATA_SOURCE } from '@/modules/org/db/org-data-source';

export const OIDC_TX_TTL_SECONDS = 600;
export const DEFAULT_RETURN_TO = '/organizations';
const STATE_PREFIX = 'org:auth:oidc:state:';
const AUTHORIZE_PER_IP = 30;
const CALLBACK_PER_IP = 10;
const WINDOW_SECONDS = 60;
const UNIQUE_VIOLATION = '23505';

/** Redis state record, consumed once with GETDEL (amendment A6). */
type OidcTx = {
  verifier: string;
  nonce: string;
  /** SHA-256 of the `org_oidc_tx` cookie that binds the flow to one browser. */
  txHash: string;
  returnTo: string;
  /** Set by linking flows (Task 12): the callback must come from this session. */
  sessionId?: string;
};

/** A relative app path, or the default: no scheme, `//`, `/\`, backslash or control chars. */
export function safeReturnTo(value: unknown): string {
  return typeof value === 'string' &&
    value.length <= 2048 &&
    // eslint-disable-next-line no-control-regex -- rejecting control chars is the point
    /^\/(?![/\\])[^\\\x00-\x1f\x7f]*$/.test(value)
    ? value
    : DEFAULT_RETURN_TO;
}

@Injectable()
export class OidcService {
  private readonly postLoginRedirect: string;
  private readonly emailHashKey: Buffer;
  private readonly idleTtlSeconds: number;
  private readonly absoluteTtlSeconds: number;

  constructor(
    @InjectDataSource(ORG_DATA_SOURCE) private readonly db: DataSource,
    @Inject(ORG_REDIS) private readonly redis: OrgRedisClient,
    @Inject(Clock) private readonly clock: IClock,
    @Inject(IConfigurationService) config: IConfigurationService,
    private readonly client: OidcClient,
    private readonly sessions: SessionsRepository,
    private readonly rateLimiter: RateLimiter,
    private readonly encryption: FieldEncryptionService,
    private readonly securityEvents: SecurityEvents,
  ) {
    this.postLoginRedirect = config.getOrThrow<string>(
      'org.oidc.postLoginRedirect',
    );
    this.emailHashKey = Buffer.from(
      config.getOrThrow<string>('org.emailHashKey'),
      'base64',
    );
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

  /** Stores the state record; `tx` goes into the browser-binding cookie. */
  async start(args: {
    connection: OidcConnection;
    returnTo: unknown;
    ip: string;
  }): Promise<{ redirectUrl: string; tx: string }> {
    await this.limit(`oidc:authorize:ip:${args.ip}`, AUTHORIZE_PER_IP);
    const state = generateToken();
    const nonce = generateToken();
    const verifier = generateToken();
    const tx = generateToken();
    const record: OidcTx = {
      verifier,
      nonce,
      txHash: sha256Hex(tx),
      returnTo: safeReturnTo(args.returnTo),
    };
    await this.redis.set(STATE_PREFIX + state, JSON.stringify(record), {
      EX: OIDC_TX_TTL_SECONDS,
      NX: true,
    });
    const redirectUrl = this.client.authorizeUrl({
      state,
      nonce,
      codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
      connection: args.connection,
    });
    return { redirectUrl, tx };
  }

  /**
   * The state is consumed before any other check, so it is single-use even
   * when the request is rejected. Every failure is a bare 401.
   */
  async complete(args: {
    code: unknown;
    state: unknown;
    tx: unknown;
    ip: string;
    userAgent: string | null;
  }): Promise<{ token: string; redirectUrl: string }> {
    await this.limit(`oidc:callback:ip:${args.ip}`, CALLBACK_PER_IP);
    if (typeof args.state !== 'string' || args.state === '') throw failed();
    const raw = await this.redis.getDel(STATE_PREFIX + args.state);
    if (raw === null) throw failed();
    const record = JSON.parse(raw) as OidcTx;
    if (
      typeof args.tx !== 'string' ||
      !timingSafeEqual(
        Buffer.from(sha256Hex(args.tx)),
        Buffer.from(record.txHash),
      )
    ) {
      throw failed();
    }
    // shortcut: linking (Task 12) is not built; refuse its records until it is
    if (record.sessionId !== undefined) throw failed();
    if (typeof args.code !== 'string' || args.code === '') throw failed();

    let identity: { subject: string; email: string };
    try {
      identity = await this.client.signIn(
        args.code,
        record.verifier,
        record.nonce,
      );
    } catch {
      throw failed();
    }

    const userId = await this.findOrCreateUser(
      identity.subject,
      identity.email,
    );
    const { token } = await this.sessions.create({
      userId,
      amr: ['oidc'],
      strong: false,
      now: this.clock.now(),
      idleTtlSeconds: this.idleTtlSeconds,
      absoluteTtlSeconds: this.absoluteTtlSeconds,
      userAgent: args.userAgent,
    });
    await this.securityEvents.record(
      userId,
      'signed_in',
      { method: 'oidc' },
      args.ip,
      args.userAgent,
    );
    return {
      token,
      redirectUrl: new URL(record.returnTo, this.postLoginRedirect).toString(),
    };
  }

  /**
   * Identity by (issuer, subject). A new subject is a new user even when its
   * email matches another account: linking is explicit (Task 12).
   */
  private async findOrCreateUser(
    subject: string,
    email: string,
  ): Promise<string> {
    const issuer = this.client.issuerId;
    const emailEncrypted = this.encryption.encrypt(email);
    const emailHash = hmacEmail(email, this.emailHashKey);
    const find = async (): Promise<
      { id: string; userId: string; status: string } | undefined
    > => {
      const [row] = await this.db.query(
        `SELECT i.id, i.user_id AS "userId", u.status FROM identities i
         JOIN users u ON u.id = i.user_id
         WHERE i.kind = 'oidc' AND i.oidc_issuer = $1 AND i.oidc_subject = $2`,
        [issuer, subject],
      );
      return row;
    };
    const known = async (row: {
      id: string;
      userId: string;
      status: string;
    }): Promise<string> => {
      if (row.status !== 'active') throw failed();
      // the IdP may have changed the address since the last sign-in
      await this.db.query(
        `UPDATE identities SET email_encrypted = $2, email_hash = $3, updated_at = $4 WHERE id = $1`,
        [row.id, emailEncrypted, emailHash, this.clock.now()],
      );
      return row.userId;
    };

    const existing = await find();
    if (existing) return known(existing);
    try {
      return await this.db.transaction(async (em) => {
        const [{ id }] = await em.query(
          `INSERT INTO users DEFAULT VALUES RETURNING id`,
        );
        await em.query(
          `INSERT INTO identities (user_id, kind, oidc_issuer, oidc_subject, email_encrypted, email_hash)
           VALUES ($1, 'oidc', $2, $3, $4, $5)`,
          [id, issuer, subject, emailEncrypted, emailHash],
        );
        return id as string;
      });
    } catch (error) {
      // a concurrent first sign-in of the same identity won the unique index
      const winner =
        (error as { code?: string }).code === UNIQUE_VIOLATION
          ? await find()
          : undefined;
      if (winner) return known(winner);
      throw error;
    }
  }

  private async limit(key: string, limit: number): Promise<void> {
    if (!(await this.rateLimiter.hit(key, limit, WINDOW_SECONDS))) {
      throw new HttpException(
        { statusCode: 429, message: 'Too many attempts' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}

function failed(): UnauthorizedException {
  return new UnauthorizedException('OIDC sign-in failed');
}
