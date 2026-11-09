import {
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomBytes } from 'node:crypto';
import type { DataSource, EntityManager } from 'typeorm';
import { AuthService } from '@/modules/org/auth/auth.service';
import type { OrgSession } from '@/modules/org/auth/decorators';
import { SecurityEvents } from '@/modules/org/auth/security-events';
import { SessionsRepository } from '@/modules/org/auth/sessions.repository';
import { StrongAuthGuard } from '@/modules/org/auth/strong-auth.guard';
import { Clock, type IClock } from '@/modules/org/common/clock';
import { RateLimiter } from '@/modules/org/common/rate-limiter';
import { FieldEncryptionService } from '@/modules/org/crypto/field-encryption.service';
import { sha256Hex } from '@/modules/org/crypto/hashing';
import { totp } from '@/modules/org/crypto/totp';
import { ORG_DATA_SOURCE } from '@/modules/org/db/org-data-source';

// spec §8: TOTP verify 5 failures per 15 min per user (codes and recovery codes)
const MAX_FAILURES = 5;
const FAILURE_WINDOW_SECONDS = 15 * 60;
const RECOVERY_CODES = 10;

type Client = { ip: string; userAgent: string | null };

/** 80-bit code shown as `xxxxx-xxxxx-xxxxx-xxxxx` (hex). */
function newRecoveryCode(): string {
  return randomBytes(10).toString('hex').match(/.{5}/g)!.join('-');
}

function hashRecoveryCode(code: string): string {
  return sha256Hex(code.toLowerCase().replace(/[\s-]/g, ''));
}

/** TOTP enrolment, confirmation, step-up and removal; single use per A7. */
@Injectable()
export class FactorsService {
  constructor(
    @InjectDataSource(ORG_DATA_SOURCE) private readonly db: DataSource,
    @Inject(Clock) private readonly clock: IClock,
    private readonly auth: AuthService,
    private readonly strongAuth: StrongAuthGuard,
    private readonly sessions: SessionsRepository,
    private readonly rateLimiter: RateLimiter,
    private readonly encryption: FieldEncryptionService,
    private readonly securityEvents: SecurityEvents,
  ) {}

  /**
   * A17: a user with a strong factor (wallet or confirmed TOTP) needs fresh
   * strong auth; a user with neither enrols with a plain session. Replaces a
   * pending (unconfirmed) enrolment.
   */
  async enroll(
    session: OrgSession,
  ): Promise<{ secret: string; otpauthUri: string }> {
    const { userId } = session;
    if (
      !this.strongAuth.isFresh(session) &&
      (await this.auth.stepUpMethods(userId)).length > 0
    ) {
      throw await this.strongAuth.denial(userId);
    }
    const secret = totp.generateSecret();
    await this.db.transaction(async (em) => {
      await this.lockUser(em, userId);
      if (await this.confirmedFactor(em, userId)) throw alreadyEnrolled();
      await em.query(
        `DELETE FROM factors WHERE user_id = $1 AND confirmed_at IS NULL`,
        [userId],
      );
      await em.query(
        `INSERT INTO factors (user_id, kind, secret_encrypted) VALUES ($1, 'totp', $2)`,
        [userId, this.encryption.encrypt(secret)],
      );
    });
    const [identity] = (await this.auth.me(session)).identities;
    const label =
      identity?.kind === 'wallet'
        ? identity.walletAddress
        : (identity?.email ?? userId);
    return { secret, otpauthUri: totp.otpauthUri(secret, label) };
  }

  /**
   * Confirms the pending factor; the session becomes strong (A17) under a new
   * token, and the user's other sessions are revoked.
   */
  async confirm(
    session: OrgSession,
    code: string,
    client: Client,
  ): Promise<{ recoveryCodes: Array<string>; token: string }> {
    const { userId } = session;
    const recoveryCodes = Array.from(
      { length: RECOVERY_CODES },
      newRecoveryCode,
    );
    await this.attempt(userId, () =>
      this.db.transaction(async (em) => {
        await this.lockUser(em, userId);
        if (await this.confirmedFactor(em, userId)) throw alreadyEnrolled();
        const [pending]: Array<{ id: string; secret: string }> = await em.query(
          `SELECT id, secret_encrypted AS "secret" FROM factors
           WHERE user_id = $1 AND confirmed_at IS NULL
           ORDER BY created_at DESC LIMIT 1`,
          [userId],
        );
        if (!pending) {
          throw new ConflictException({
            statusCode: 409,
            message: 'No pending TOTP enrolment',
            code: 'totp_not_pending',
          });
        }
        const now = this.clock.now();
        const check = totp.verify(
          this.encryption.decrypt(pending.secret),
          code,
          now,
          null,
        );
        if (!check.ok) return false;
        await em.query(
          `UPDATE factors SET confirmed_at = $2, last_used_step = $3, updated_at = $2 WHERE id = $1`,
          [pending.id, now, check.step],
        );
        await em.query(`DELETE FROM recovery_codes WHERE user_id = $1`, [
          userId,
        ]);
        await em.query(
          `INSERT INTO recovery_codes (user_id, code_hash)
           SELECT $1, unnest($2::text[])`,
          [userId, recoveryCodes.map(hashRecoveryCode)],
        );
        // F3: a new factor ends every other session
        await this.sessions.revokeOthers(userId, session.sessionId, now, em);
        return true;
      }),
    );
    // F2: fresh possession of the new factor rotates the session token
    const token = await this.sessions.elevate(
      session.sessionId,
      'totp',
      this.clock.now(),
    );
    await this.securityEvents.record(
      userId,
      'security.totp_enrolled',
      {},
      client.ip,
      client.userAgent,
    );
    return { recoveryCodes, token };
  }

  async stepUp(
    session: OrgSession,
    proof: { code?: string; recoveryCode?: string },
    client: Client,
  ): Promise<string> {
    const { userId } = session;
    const method = proof.code !== undefined ? 'totp' : 'recovery_code';
    await this.attempt(userId, () =>
      proof.code !== undefined
        ? this.useTotp(userId, proof.code)
        : this.useRecoveryCode(userId, proof.recoveryCode!),
    );
    const token = await this.sessions.elevate(
      session.sessionId,
      method,
      this.clock.now(),
    );
    await this.securityEvents.record(
      userId,
      'security.step_up',
      { method },
      client.ip,
      client.userAgent,
    );
    return token;
  }

  /**
   * Caller is behind `@RequireStrongAuth()`. Removes the factor and its
   * recovery codes and revokes the user's other sessions.
   */
  async remove(session: OrgSession, client: Client): Promise<void> {
    const { userId } = session;
    await this.db.transaction(async (em) => {
      await this.lockUser(em, userId);
      await em.query(`DELETE FROM factors WHERE user_id = $1`, [userId]);
      await em.query(`DELETE FROM recovery_codes WHERE user_id = $1`, [userId]);
      await this.sessions.revokeOthers(
        userId,
        session.sessionId,
        this.clock.now(),
        em,
      );
    });
    await this.securityEvents.record(
      userId,
      'security.totp_removed',
      {},
      client.ip,
      client.userAgent,
    );
  }

  /** A7: the step is accepted by exactly one caller. */
  private async useTotp(userId: string, code: string): Promise<boolean> {
    const [factor]: Array<{
      id: string;
      secret: string;
      lastUsedStep: string | null;
    }> = await this.db.query(
      `SELECT id, secret_encrypted AS "secret", last_used_step AS "lastUsedStep"
       FROM factors WHERE user_id = $1 AND confirmed_at IS NOT NULL`,
      [userId],
    );
    if (!factor) return false;
    const now = this.clock.now();
    const check = totp.verify(
      this.encryption.decrypt(factor.secret),
      code,
      now,
      factor.lastUsedStep === null ? null : Number(factor.lastUsedStep),
    );
    if (!check.ok) return false;
    const [, updated] = await this.db.query(
      `UPDATE factors SET last_used_step = $2, updated_at = $3
       WHERE id = $1 AND (last_used_step IS NULL OR last_used_step < $2)`,
      [factor.id, check.step, now],
    );
    return updated === 1;
  }

  /** A7: a recovery code is spent by exactly one caller; only with a confirmed TOTP. */
  private async useRecoveryCode(
    userId: string,
    code: string,
  ): Promise<boolean> {
    const [, updated] = await this.db.query(
      `UPDATE recovery_codes SET used_at = $3, updated_at = $3
       WHERE code_hash = $1 AND user_id = $2 AND used_at IS NULL
         AND EXISTS (SELECT 1 FROM factors
           WHERE user_id = $2 AND kind = 'totp' AND confirmed_at IS NOT NULL)`,
      [hashRecoveryCode(code), userId, this.clock.now()],
    );
    return updated === 1;
  }

  /**
   * Reserves an attempt atomically before verifying (parallel guesses cannot
   * exceed the limit) and gives it back unless the code was wrong.
   */
  private async attempt(
    userId: string,
    verify: () => Promise<boolean>,
  ): Promise<void> {
    const key = `totp:user:${userId}`;
    if (
      !(await this.rateLimiter.hit(key, MAX_FAILURES, FAILURE_WINDOW_SECONDS))
    ) {
      throw new HttpException(
        { statusCode: 429, message: 'Too many failed attempts, try later' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    let ok: boolean;
    try {
      ok = await verify();
    } catch (error) {
      await this.rateLimiter.refund(key);
      throw error;
    }
    if (!ok) throw new UnauthorizedException('Invalid code');
    await this.rateLimiter.refund(key);
  }

  /** Serialises enrol/confirm/remove per user (one confirmed TOTP at most). */
  private async lockUser(em: EntityManager, userId: string): Promise<void> {
    await em.query(`SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, [userId]);
  }

  private async confirmedFactor(
    em: EntityManager,
    userId: string,
  ): Promise<boolean> {
    const [row] = await em.query(
      `SELECT 1 FROM factors WHERE user_id = $1 AND confirmed_at IS NOT NULL`,
      [userId],
    );
    return row !== undefined;
  }
}

function alreadyEnrolled(): ConflictException {
  return new ConflictException({
    statusCode: 409,
    message: 'TOTP is already enabled; remove it first',
    code: 'totp_exists',
  });
}
