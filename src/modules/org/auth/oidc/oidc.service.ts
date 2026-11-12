import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { DataSource, EntityManager } from 'typeorm';
import { IConfigurationService } from '@/config/configuration.service.interface';
import {
  type ILoggingService,
  LoggingService,
} from '@/logging/logging.interface';
import {
  ORG_REDIS,
  OrgKeyPrefix,
  type OrgRedisClient,
} from '@/modules/org/auth/nonce.store';
import { OidcClient } from '@/modules/org/auth/oidc/oidc.client';
import { attachIdentity } from '@/modules/org/auth/identities';
import { SecurityEvents } from '@/modules/org/auth/security-events';
import { SessionsRepository } from '@/modules/org/auth/sessions.repository';
import { Clock, type IClock } from '@/modules/org/common/clock';
import { ipBucket, RateLimiter } from '@/modules/org/common/rate-limiter';
import { FieldEncryptionService } from '@/modules/org/crypto/field-encryption.service';
import {
  generateToken,
  hmacEmail,
  sha256Hex,
} from '@/modules/org/crypto/hashing';
import { ORG_DATA_SOURCE } from '@/modules/org/db/org-data-source';

export const OIDC_TX_TTL_SECONDS = 600;
export const DEFAULT_RETURN_TO = '/organizations';
const AUTHORIZE_PER_IP = 30;
const CALLBACK_PER_IP = 10;
const WINDOW_SECONDS = 60;
const UNIQUE_VIOLATION = '23505';
/** Link flows: an IdP authentication that reports `auth_time` must be at most this old. */
const LINK_MAX_AUTH_AGE_SECONDS = 300;
/** Issuer of email one-time-code identities; their subject is the email HMAC. */
export const EMAIL_OTP_ISSUER = 'urn:protofire:email-otp';

/** An identity whose email the issuer (Google) or a mailed code verified. */
export type VerifiedIdentity = {
  issuer: string;
  subject: string;
  email: string;
};
type Client = { ip: string; userAgent: string | null };

/** Redis state record, consumed once with GETDEL (amendment A6). */
type OidcTx = {
  verifier: string;
  nonce: string;
  /** SHA-256 of the `__Host-org_oidc_tx` cookie that binds the flow to one browser. */
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
  private readonly strongAuthWindowMs: number;
  private readonly statePrefix: string;

  constructor(
    @InjectDataSource(ORG_DATA_SOURCE) private readonly db: DataSource,
    @Inject(ORG_REDIS) private readonly redis: OrgRedisClient,
    @Inject(OrgKeyPrefix) keyPrefix: string,
    @Inject(Clock) private readonly clock: IClock,
    @Inject(IConfigurationService) config: IConfigurationService,
    private readonly client: OidcClient,
    private readonly sessions: SessionsRepository,
    private readonly rateLimiter: RateLimiter,
    private readonly encryption: FieldEncryptionService,
    private readonly securityEvents: SecurityEvents,
    @Inject(LoggingService) private readonly logger: ILoggingService,
  ) {
    this.statePrefix = `${keyPrefix}auth:oidc:state:`;
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
    this.strongAuthWindowMs =
      config.getOrThrow<number>('org.session.strongAuthWindowSeconds') * 1000;
  }

  get sessionMaxAgeSeconds(): number {
    return this.absoluteTtlSeconds;
  }

  /**
   * Stores the state record; `tx` goes into the browser-binding cookie.
   * `sessionId` starts a linking flow (A6): the callback then attaches the
   * identity to that session's user instead of signing in.
   */
  async start(args: {
    returnTo: unknown;
    ip: string;
    sessionId?: string;
  }): Promise<{ redirectUrl: string; tx: string }> {
    await this.limit(
      `oidc:authorize:ip:${ipBucket(args.ip)}`,
      AUTHORIZE_PER_IP,
    );
    const state = generateToken();
    const nonce = generateToken();
    const verifier = generateToken();
    const tx = generateToken();
    const record: OidcTx = {
      verifier,
      nonce,
      txHash: sha256Hex(tx),
      returnTo: safeReturnTo(args.returnTo),
      ...(args.sessionId ? { sessionId: args.sessionId } : {}),
    };
    const redirectUrl = await this.client.authorizeUrl({
      state,
      nonce,
      codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
      // linking (item 4): the user picks the account, never silently whoever
      // is signed in at the IdP; the start already needed fresh strong auth
      ...(args.sessionId ? { prompt: 'select_account' as const } : {}),
    });
    await this.redis.set(this.statePrefix + state, JSON.stringify(record), {
      EX: OIDC_TX_TTL_SECONDS,
      NX: true,
    });
    return { redirectUrl, tx };
  }

  /**
   * Never throws: the browser is always sent back to the app (item 5), on
   * failure with `?orgAuthError=<code>` added to the flow's returnTo (or the
   * default when the state is unknown). The state is consumed before any
   * other check, so it is single-use even when the request is rejected.
   * `token` is null after linking (the current session stays) and on failure.
   */
  async complete(args: {
    /** The IdP's `error` parameter (e.g. `access_denied` on cancel). */
    error?: unknown;
    code: unknown;
    state: unknown;
    tx: unknown;
    /** The `__Host-org_session` cookie; only read in linking flows. */
    sessionToken: unknown;
    ip: string;
    userAgent: string | null;
  }): Promise<{ token: string | null; redirectUrl: string }> {
    let returnTo = DEFAULT_RETURN_TO;
    try {
      return await this.completeOrThrow(args, (r) => (returnTo = r));
    } catch (error) {
      const url = new URL(returnTo, this.postLoginRedirect);
      url.searchParams.set('orgAuthError', this.errorCode(error));
      return { token: null, redirectUrl: url.toString() };
    }
  }

  private async completeOrThrow(
    args: Parameters<OidcService['complete']>[0],
    setReturnTo: (returnTo: string) => void,
  ): Promise<{ token: string | null; redirectUrl: string }> {
    await this.limit(`oidc:callback:ip:${ipBucket(args.ip)}`, CALLBACK_PER_IP);
    if (typeof args.state !== 'string' || args.state === '') {
      throw new CallbackError('expired');
    }
    const raw = await this.redis.getDel(this.statePrefix + args.state);
    if (raw === null) throw new CallbackError('expired');
    const record = JSON.parse(raw) as OidcTx;
    if (
      typeof args.tx !== 'string' ||
      !timingSafeEqual(
        Buffer.from(sha256Hex(args.tx)),
        Buffer.from(record.txHash),
      )
    ) {
      throw new CallbackError('failed');
    }
    // known and bound to this browser: failures may go back to its returnTo
    setReturnTo(record.returnTo);
    if (args.error !== undefined) throw new CallbackError('cancelled');
    // A6: a linking flow must come back to the session that started it
    let linkUserId: string | undefined;
    if (record.sessionId !== undefined) {
      const session =
        typeof args.sessionToken === 'string'
          ? await this.sessions.findActive(args.sessionToken, this.clock.now())
          : null;
      if (session?.id !== record.sessionId) throw new CallbackError('failed');
      linkUserId = session.userId;
    }
    if (typeof args.code !== 'string' || args.code === '') {
      throw new CallbackError('failed');
    }

    let identity: { subject: string; email: string; authTime?: number };
    try {
      identity = await this.client.signIn(
        args.code,
        record.verifier,
        record.nonce,
      );
    } catch {
      throw new CallbackError('failed');
    }
    const verified: VerifiedIdentity = {
      issuer: this.client.issuerId,
      subject: identity.subject,
      email: identity.email,
    };
    const redirectUrl = new URL(record.returnTo, this.postLoginRedirect);
    if (linkUserId !== undefined) {
      // Google does not document auth_time; the link start needed fresh
      // strong auth and the callback is bound to that session. An issuer
      // that reports auth_time must report a recent one.
      if (
        identity.authTime !== undefined &&
        !(
          this.clock.now().getTime() / 1000 - identity.authTime <=
          LINK_MAX_AUTH_AGE_SECONDS
        )
      ) {
        throw new CallbackError('reauth_required');
      }
      await this.link(linkUserId, record.sessionId!, verified, args);
      return { token: null, redirectUrl: redirectUrl.toString() };
    }

    const signedIn = await this.signIn(verified, args);
    if (!signedIn) throw new CallbackError('failed');
    if (signedIn.linkHint) redirectUrl.searchParams.set('orgLinkHint', '1');
    return { token: signedIn.token, redirectUrl: redirectUrl.toString() };
  }

  /**
   * Session for a verified identity (never strong: neither Google nor an
   * email code is a step-up factor); null when the user is not active.
   * `linkHint`: another user has an identity with the same email under
   * another sign-in method (no implicit merge: the UI suggests linking).
   */
  async signIn(
    identity: VerifiedIdentity,
    client: Client,
  ): Promise<{ userId: string; token: string; linkHint: boolean } | null> {
    const userId = await this.findOrCreateUser(identity);
    if (userId === null) return null;
    const method = identity.issuer === EMAIL_OTP_ISSUER ? 'email_otp' : 'oidc';
    const { token } = await this.sessions.create({
      userId,
      amr: [method],
      strong: false,
      now: this.clock.now(),
      idleTtlSeconds: this.idleTtlSeconds,
      absoluteTtlSeconds: this.absoluteTtlSeconds,
      userAgent: client.userAgent,
    });
    await this.securityEvents.record(
      userId,
      'security.signed_in',
      { method },
      client.ip,
      client.userAgent,
    );
    const [hint] = await this.db.query(
      `SELECT 1 FROM identities
       WHERE kind = 'oidc' AND email_hash = $1 AND user_id <> $2 AND oidc_issuer <> $3
       LIMIT 1`,
      [hmacEmail(identity.email, this.emailHashKey), userId, identity.issuer],
    );
    return { userId, token, linkHint: hint !== undefined };
  }

  private errorCode(error: unknown): OidcErrorCode {
    if (error instanceof CallbackError) return error.code;
    if (error instanceof HttpException) {
      if (error.getStatus() === 429) return 'rate_limited';
      const body = error.getResponse() as { code?: unknown };
      if (body?.code === 'identity_taken') return 'identity_taken';
      if (body?.code === 'reauth_required') return 'reauth_required';
    }
    this.logger.error(
      `OIDC callback failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 'failed';
  }

  /**
   * Attaches the verified identity to the user; a new link ends their other
   * sessions. 409 `identity_taken` when it belongs to another user.
   */
  async link(
    userId: string,
    sessionId: string,
    identity: VerifiedIdentity,
    client: Client,
  ): Promise<void> {
    const linked = await this.db.transaction(async (em) => {
      await this.lockLinkingSession(em, userId, sessionId);
      const added = await attachIdentity(em, userId, {
        kind: 'oidc',
        issuer: identity.issuer,
        subject: identity.subject,
        emailEncrypted: this.encryption.encrypt(identity.email),
        emailHash: hmacEmail(identity.email, this.emailHashKey),
      });
      if (added) {
        await this.sessions.revokeOthers(
          userId,
          sessionId,
          this.clock.now(),
          em,
        );
      }
      return added;
    });
    if (linked) {
      await this.securityEvents.record(
        userId,
        'security.identity_linked',
        {
          kind: identity.issuer === EMAIL_OTP_ISSUER ? 'email_otp' : 'oidc',
        },
        client.ip,
        client.userAgent,
      );
    }
  }

  /**
   * The flow outlived its checks (token exchange, mailed code): the session
   * must still be live, the user's, and strong-fresh. FOR UPDATE serialises
   * with a concurrent revocation (an UPDATE of the same row).
   */
  private async lockLinkingSession(
    em: EntityManager,
    userId: string,
    sessionId: string,
  ): Promise<void> {
    const now = this.clock.now();
    const [session]: Array<{ lastStrongAuthAt: Date | null }> = await em.query(
      `SELECT s.last_strong_auth_at AS "lastStrongAuthAt"
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = $1 AND s.user_id = $2 AND s.revoked_at IS NULL
         AND s.expires_at > $3 AND s.idle_expires_at > $3 AND u.status = 'active'
       FOR UPDATE OF s`,
      [sessionId, userId, now],
    );
    const strong = session?.lastStrongAuthAt;
    if (!strong || now.getTime() - strong.getTime() > this.strongAuthWindowMs) {
      throw new ForbiddenException({
        statusCode: 403,
        message: 'Sign in again and confirm with a strong factor to link',
        code: 'reauth_required',
      });
    }
  }

  /**
   * Identity by (issuer, subject); a new subject is always a new user. Never
   * attach by email: mailbox access or a recycled address would take over
   * the account (decision reversed 2026-11-10); linking is explicit, while
   * signed in (link flow). Null for a user that is not active.
   */
  private async findOrCreateUser(
    identity: VerifiedIdentity,
  ): Promise<string | null> {
    const { issuer, subject } = identity;
    const emailEncrypted = this.encryption.encrypt(identity.email);
    const emailHash = hmacEmail(identity.email, this.emailHashKey);
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
    }): Promise<string | null> => {
      if (row.status !== 'active') return null;
      // the IdP may have changed the address since the last sign-in; an
      // email-code identity is its address (subject = email HMAC)
      if (issuer === EMAIL_OTP_ISSUER) return row.userId;
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

export type OidcErrorCode =
  | 'cancelled'
  | 'expired'
  | 'failed'
  | 'identity_taken'
  | 'rate_limited'
  | 'reauth_required';

/** An expected callback failure, answered with `?orgAuthError=<code>`. */
class CallbackError extends Error {
  constructor(readonly code: OidcErrorCode) {
    super(`OIDC callback failed: ${code}`);
  }
}
