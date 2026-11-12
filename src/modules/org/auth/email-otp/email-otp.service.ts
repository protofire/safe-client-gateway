import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  UnauthorizedException,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { IConfigurationService } from '@/config/configuration.service.interface';
import {
  type ILoggingService,
  LoggingService,
} from '@/logging/logging.interface';
import type { OrgSession } from '@/modules/org/auth/decorators';
import {
  ORG_REDIS,
  OrgKeyPrefix,
  type OrgRedisClient,
} from '@/modules/org/auth/nonce.store';
import {
  EMAIL_OTP_ISSUER,
  OidcService,
  type VerifiedIdentity,
} from '@/modules/org/auth/oidc/oidc.service';
import { Clock, type IClock } from '@/modules/org/common/clock';
import { ipBucket, RateLimiter } from '@/modules/org/common/rate-limiter';
import { FieldEncryptionService } from '@/modules/org/crypto/field-encryption.service';
import {
  generateToken,
  hmacEmail,
  normalizeEmail,
  sha256Hex,
} from '@/modules/org/crypto/hashing';
import { ORG_DATA_SOURCE } from '@/modules/org/db/org-data-source';
import { MailService } from '@/modules/org/mail/mail.service';

export const EMAIL_CODE_TTL_SECONDS = 600;
const CODE_DIGITS = 8;
const MAX_ATTEMPTS = 5;
const START_PER_IP = 10;
const START_IP_WINDOW_SECONDS = 600;
const VERIFY_PER_IP = 30;
const VERIFY_IP_WINDOW_SECONDS = 60;
const LINK_STARTS_PER_USER_PER_HOUR = 5;
/** Codes mailed to one address: 1/min, 5/hour, 10/day. */
const SENDS_PER_EMAIL: Array<[limit: number, windowSeconds: number]> = [
  [1, 60],
  [5, 3600],
  [10, 86400],
];

/** Redis record, keyed by the SHA-256 of the browser's tx cookie (never by email). */
type CodeRecord = {
  /** HMAC(emailHashKey, code‖emailHash‖tx): neither the code nor a plain hash of it. */
  mac: string;
  emailHash: string;
  emailEncrypted: string;
  /** Link flows: the session that started it must finish it. */
  sessionId?: string;
};

type Client = { ip: string; userAgent: string | null };

function invalidCode(): UnauthorizedException {
  return new UnauthorizedException({
    statusCode: 401,
    message: 'Invalid or expired code',
    code: 'code_invalid',
  });
}

/**
 * Email one-time codes, mailed by this service. The code is bound to the
 * requesting browser (tx cookie) and stored only as an HMAC. Whether a code
 * was mailed is never observable: `start` answers the same for every
 * address and mails after the response.
 */
@Injectable()
export class EmailOtpService implements OnApplicationShutdown {
  private readonly prefix: string;
  private readonly emailHashKey: Buffer;
  private readonly maxSendsPerHour: number;
  // null: ORG_CREATE_ALLOWLIST is empty (open sign-up), anyone may get a code
  private readonly allowlistHashes: Set<string> | null;
  private readonly pending = new Set<Promise<void>>();

  constructor(
    @InjectDataSource(ORG_DATA_SOURCE) private readonly db: DataSource,
    @Inject(ORG_REDIS) private readonly redis: OrgRedisClient,
    @Inject(OrgKeyPrefix) keyPrefix: string,
    @Inject(Clock) private readonly clock: IClock,
    @Inject(IConfigurationService) config: IConfigurationService,
    @Inject(LoggingService) private readonly logger: ILoggingService,
    private readonly rateLimiter: RateLimiter,
    private readonly encryption: FieldEncryptionService,
    private readonly mail: MailService,
    private readonly oidc: OidcService,
  ) {
    this.prefix = `${keyPrefix}auth:email:tx:`;
    this.emailHashKey = Buffer.from(
      config.getOrThrow<string>('org.emailHashKey'),
      'base64',
    );
    this.maxSendsPerHour = config.getOrThrow<number>(
      'org.emailOtp.maxSendsPerHour',
    );
    const { wallets = [], emails = [] } =
      config.get<{ wallets: Array<string>; emails: Array<string> }>(
        'org.createAllowlist',
      ) ?? {};
    this.allowlistHashes =
      wallets.length + emails.length === 0
        ? null
        : new Set(emails.map((e) => hmacEmail(e, this.emailHashKey)));
  }

  get sessionMaxAgeSeconds(): number {
    return this.oidc.sessionMaxAgeSeconds;
  }

  /**
   * Answers the tx for the browser-binding cookie; the code is mailed after
   * the response, if the address passes the gate and the send limits.
   * `session`: a linking flow (the route needs fresh strong auth).
   */
  async start(args: {
    email: string;
    ip: string;
    session?: OrgSession;
  }): Promise<{ tx: string }> {
    await this.rateLimiter.enforce(
      `email-otp:start:ip:${ipBucket(args.ip)}`,
      START_PER_IP,
      START_IP_WINDOW_SECONDS,
    );
    if (args.session) {
      await this.rateLimiter.enforce(
        `email-otp:link:user:${args.session.userId}`,
        LINK_STARTS_PER_USER_PER_HOUR,
        3600,
      );
    }
    const tx = generateToken();
    const email = normalizeEmail(args.email);
    const sessionId = args.session?.sessionId;
    // after the response: its timing must not depend on the gate or the mail
    const sending = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => this.deliver(email, tx, sessionId))
      .catch((error: unknown) =>
        this.logger.error(
          `email code not sent: ${error instanceof Error ? error.message : String(error)}`,
        ),
      )
      .finally(() => this.pending.delete(sending));
    this.pending.add(sending);
    return { tx };
  }

  /** Signs in (never strong); 401 `code_invalid` for any wrong, used, expired or unknown code. */
  async signIn(
    code: string,
    tx: unknown,
    client: Client,
  ): Promise<{ userId: string; token: string; linkHint: boolean }> {
    const identity = await this.verify(code, tx, client.ip, undefined);
    const signedIn = await this.oidc.signIn(identity, client);
    if (!signedIn) throw invalidCode();
    return signedIn;
  }

  /** Links the address to the session user; 409 `identity_taken` if another user has it. */
  async link(
    session: OrgSession,
    code: string,
    tx: unknown,
    client: Client,
  ): Promise<void> {
    const identity = await this.verify(code, tx, client.ip, session.sessionId);
    await this.oidc.link(session.userId, session.sessionId, identity, client);
  }

  /** Waits for mails still being sent (shutdown; tests). */
  async drain(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.drain();
  }

  private async deliver(
    email: string,
    tx: string,
    sessionId: string | undefined,
  ): Promise<void> {
    const emailHash = hmacEmail(email, this.emailHashKey);
    // anti mail-bombing: sign-in codes only to addresses we know, unless sign-up is open
    if (sessionId === undefined && !(await this.mayReceive(emailHash))) return;
    for (const [limit, window] of SENDS_PER_EMAIL) {
      const key = `email-otp:send:email:${emailHash}:${window}`;
      if (!(await this.rateLimiter.hit(key, limit, window))) return;
    }
    if (
      !(await this.rateLimiter.hit(
        'email-otp:send:global',
        this.maxSendsPerHour,
        3600,
      ))
    ) {
      this.logger.error(
        `email code sends stopped: over ORG_EMAIL_OTP_MAX_SENDS_PER_HOUR (${this.maxSendsPerHour})`,
      );
      return;
    }
    const code = randomInt(0, 10 ** CODE_DIGITS)
      .toString()
      .padStart(CODE_DIGITS, '0');
    const record: CodeRecord = {
      mac: this.mac(code, emailHash, tx),
      emailHash,
      emailEncrypted: this.encryption.encrypt(email),
      ...(sessionId !== undefined ? { sessionId } : {}),
    };
    await this.redis.set(this.key(tx), JSON.stringify(record), {
      EX: EMAIL_CODE_TTL_SECONDS,
    });
    await this.mail.sendSignInCode(email, code);
  }

  /** An identity's address, a pending invitation target, or listed in ORG_CREATE_ALLOWLIST. */
  private async mayReceive(emailHash: string): Promise<boolean> {
    if (this.allowlistHashes === null) return true;
    if (this.allowlistHashes.has(emailHash)) return true;
    const [{ known }] = await this.db.query(
      `SELECT EXISTS (SELECT 1 FROM identities WHERE kind = 'oidc' AND email_hash = $1)
         OR EXISTS (SELECT 1 FROM invitations i
           JOIN members m ON m.id = i.member_id AND m.status = 'invited'
           WHERE i.target_email_hash = $1 AND i.accepted_at IS NULL
             AND i.declined_at IS NULL AND i.expires_at > $2) AS known`,
      [emailHash, this.clock.now()],
    );
    return known;
  }

  /**
   * The attempt is counted before the comparison (parallel guesses cannot
   * exceed the limit) and never given back; the record is consumed with
   * GETDEL, so exactly one caller wins it.
   */
  private async verify(
    code: string,
    tx: unknown,
    ip: string,
    sessionId: string | undefined,
  ): Promise<VerifiedIdentity> {
    await this.rateLimiter.enforce(
      `email-otp:verify:ip:${ipBucket(ip)}`,
      VERIFY_PER_IP,
      VERIFY_IP_WINDOW_SECONDS,
    );
    if (typeof tx !== 'string' || tx === '') throw invalidCode();
    const key = this.key(tx);
    if (
      !(await this.rateLimiter.hit(
        `email-otp:attempts:${sha256Hex(tx)}`,
        MAX_ATTEMPTS,
        EMAIL_CODE_TTL_SECONDS,
      ))
    ) {
      await this.redis.del(key);
      throw new HttpException(
        {
          statusCode: 429,
          message: 'Too many attempts, request a new code',
          code: 'too_many_attempts',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const raw = await this.redis.get(key);
    if (raw === null) throw invalidCode();
    const record = JSON.parse(raw) as CodeRecord;
    const expected = Buffer.from(record.mac, 'hex');
    const actual = Buffer.from(this.mac(code, record.emailHash, tx), 'hex');
    if (
      record.sessionId !== sessionId ||
      !timingSafeEqual(expected, actual) ||
      (await this.redis.getDel(key)) === null
    ) {
      throw invalidCode();
    }
    return {
      issuer: EMAIL_OTP_ISSUER,
      subject: record.emailHash,
      email: this.encryption.decrypt(record.emailEncrypted),
    };
  }

  private mac(code: string, emailHash: string, tx: string): string {
    return createHmac('sha256', this.emailHashKey)
      .update(`email-otp\0${code}\0${emailHash}\0${tx}`)
      .digest('hex');
  }

  private key(tx: string): string {
    return this.prefix + sha256Hex(tx);
  }
}
