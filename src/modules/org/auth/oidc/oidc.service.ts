import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { DataSource } from 'typeorm';
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
import {
  OidcClient,
  type OidcConnection,
} from '@/modules/org/auth/oidc/oidc.client';
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
/** Auth0 subjects of the connections we offer: passwordless email and Google. */
const SUPPORTED_SUBJECT = /^(?:email|google-oauth2)\|./;

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
    connection: OidcConnection;
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
    await this.redis.set(this.statePrefix + state, JSON.stringify(record), {
      EX: OIDC_TX_TTL_SECONDS,
      NX: true,
    });
    const redirectUrl = this.client.authorizeUrl({
      state,
      nonce,
      codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
      connection: args.connection,
      // linking (item 4): never attach whoever is signed in at the IdP already
      ...(args.sessionId ? { prompt: 'login' as const } : {}),
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
    /** The `org_session` cookie; only read in linking flows. */
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

    let identity: { subject: string; email: string };
    try {
      identity = await this.client.signIn(
        args.code,
        record.verifier,
        record.nonce,
      );
    } catch {
      throw new CallbackError('failed');
    }
    // Item 5: only the connections we offer (Auth0 prefixes the subject)
    if (!SUPPORTED_SUBJECT.test(identity.subject)) {
      throw new CallbackError('unsupported_identity');
    }

    const redirectUrl = new URL(
      record.returnTo,
      this.postLoginRedirect,
    ).toString();
    if (linkUserId !== undefined) {
      await this.link(linkUserId, record.sessionId!, identity, args);
      return { token: null, redirectUrl };
    }

    const userId = await this.findOrCreateUser(identity, args);
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
      'security.signed_in',
      { method: 'oidc' },
      args.ip,
      args.userAgent,
    );
    return { token, redirectUrl };
  }

  private errorCode(error: unknown): OidcErrorCode {
    if (error instanceof CallbackError) return error.code;
    if (error instanceof HttpException) {
      if (error.getStatus() === 429) return 'rate_limited';
      const body = error.getResponse() as { code?: unknown };
      if (body?.code === 'identity_taken') return 'identity_taken';
    }
    this.logger.error(
      `OIDC callback failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 'failed';
  }

  /** Attaches the IdP identity to the user; a new link ends their other sessions. */
  private async link(
    userId: string,
    sessionId: string,
    identity: { subject: string; email: string },
    client: { ip: string; userAgent: string | null },
  ): Promise<void> {
    const linked = await this.db.transaction(async (em) => {
      const added = await attachIdentity(em, userId, {
        kind: 'oidc',
        issuer: this.client.issuerId,
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
        { kind: 'oidc' },
        client.ip,
        client.userAgent,
      );
    }
  }

  /**
   * Identity by (issuer, subject). A new subject joins the one active user
   * holding an identity of the same issuer with the same email (item 6: the
   * same person via Google and the email code). Every stored OIDC identity
   * and this one are `email_verified` (OidcClient), so an unverified address
   * never gets here. No or several matches: a new user.
   */
  private async findOrCreateUser(
    identity: { subject: string; email: string },
    client: { ip: string; userAgent: string | null },
  ): Promise<string> {
    const issuer = this.client.issuerId;
    const { subject } = identity;
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
    }): Promise<string> => {
      if (row.status !== 'active') throw new CallbackError('failed');
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
      const { userId, attached } = await this.db.transaction(async (em) => {
        const owners: Array<{ userId: string }> = await em.query(
          `SELECT DISTINCT i.user_id AS "userId" FROM identities i
           JOIN users u ON u.id = i.user_id AND u.status = 'active'
           WHERE i.kind = 'oidc' AND i.oidc_issuer = $1 AND i.email_hash = $2`,
          [issuer, emailHash],
        );
        let id: string;
        if (owners.length === 1) {
          id = owners[0].userId;
        } else {
          [{ id }] = await em.query(
            `INSERT INTO users DEFAULT VALUES RETURNING id`,
          );
        }
        await em.query(
          `INSERT INTO identities (user_id, kind, oidc_issuer, oidc_subject, email_encrypted, email_hash)
           VALUES ($1, 'oidc', $2, $3, $4, $5)`,
          [id, issuer, subject, emailEncrypted, emailHash],
        );
        return { userId: id, attached: owners.length === 1 };
      });
      if (attached) {
        await this.securityEvents.record(
          userId,
          'security.identity_linked',
          { kind: 'oidc', via: 'sign_in' },
          client.ip,
          client.userAgent,
        );
      }
      return userId;
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
  | 'unsupported_identity';

/** An expected callback failure, answered with `?orgAuthError=<code>`. */
class CallbackError extends Error {
  constructor(readonly code: OidcErrorCode) {
    super(`OIDC callback failed: ${code}`);
  }
}
