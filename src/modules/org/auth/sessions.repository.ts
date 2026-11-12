import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import { ORG_DATA_SOURCE } from '@/modules/org/db/org-data-source';
import { generateToken, sha256Hex } from '@/modules/org/crypto/hashing';

export type SessionRow = {
  id: string;
  userId: string;
  amr: Array<string>;
  lastStrongAuthAt: Date | null;
  updatedAt: Date;
};

/** Server-side sessions; the cookie holds the token, the table only its SHA-256. */
@Injectable()
export class SessionsRepository {
  constructor(
    @InjectDataSource(ORG_DATA_SOURCE) private readonly db: DataSource,
  ) {}

  async create(args: {
    userId: string;
    amr: Array<string>;
    /** Whether sign-in itself was a strong factor (SIWE yes, OIDC no). */
    strong: boolean;
    now: Date;
    idleTtlSeconds: number;
    absoluteTtlSeconds: number;
    userAgent: string | null;
  }): Promise<{ id: string; token: string }> {
    const token = generateToken();
    const expiresAt = addSeconds(args.now, args.absoluteTtlSeconds);
    const idleExpiresAt = min(
      addSeconds(args.now, args.idleTtlSeconds),
      expiresAt,
    );
    const [{ id }] = await this.db.query(
      `INSERT INTO sessions (user_id, token_hash, amr, last_strong_auth_at,
         expires_at, idle_expires_at, user_agent, created_at, updated_at)
       VALUES ($1, $2, $3, $8, $5, $6, $7, $4, $4) RETURNING id`,
      [
        args.userId,
        sha256Hex(token),
        args.amr,
        args.now,
        expiresAt,
        idleExpiresAt,
        args.userAgent,
        args.strong ? args.now : null,
      ],
    );
    return { id, token };
  }

  async findActive(token: string, now: Date): Promise<SessionRow | null> {
    const [row] = await this.db.query(
      `SELECT s.id, s.user_id AS "userId", s.amr,
         s.last_strong_auth_at AS "lastStrongAuthAt", s.updated_at AS "updatedAt"
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL
         AND s.expires_at > $2 AND s.idle_expires_at > $2
         AND u.status = 'active'`,
      [sha256Hex(token), now],
    );
    return row ?? null;
  }

  /** Slides the idle expiry, never past the absolute one. */
  async touch(id: string, now: Date, idleTtlSeconds: number): Promise<void> {
    await this.db.query(
      `UPDATE sessions
       SET idle_expires_at = LEAST($2::timestamptz, expires_at), updated_at = $3
       WHERE id = $1`,
      [id, addSeconds(now, idleTtlSeconds), now],
    );
  }

  /**
   * Marks the session strong and rotates its token in the same row, so a
   * copy of the pre-step-up cookie stops working. Returns the new token; 401
   * if the session was revoked meanwhile.
   */
  async elevate(
    id: string,
    method: string,
    now: Date,
    em: Pick<EntityManager, 'query'> = this.db,
  ): Promise<string> {
    const token = generateToken();
    const [, updated] = await em.query(
      `UPDATE sessions
       SET last_strong_auth_at = $3, updated_at = $3, token_hash = $4,
         amr = CASE WHEN $2 = ANY(amr) THEN amr ELSE array_append(amr, $2) END
       WHERE id = $1 AND revoked_at IS NULL`,
      [id, method, now, sha256Hex(token)],
    );
    if (updated !== 1) throw new UnauthorizedException();
    return token;
  }

  /**
   * After a factor change: every session of the user except `keepId`. Pass
   * the factor change's transaction so both commit together.
   */
  async revokeOthers(
    userId: string,
    keepId: string,
    now: Date,
    em: Pick<EntityManager, 'query'> = this.db,
  ): Promise<void> {
    await em.query(
      `UPDATE sessions SET revoked_at = $3, updated_at = $3
       WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`,
      [userId, keepId, now],
    );
  }

  async revokeByToken(token: string, now: Date): Promise<void> {
    await this.db.query(
      `UPDATE sessions SET revoked_at = $2, updated_at = $2
       WHERE token_hash = $1 AND revoked_at IS NULL`,
      [sha256Hex(token), now],
    );
  }
}

function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

function min(a: Date, b: Date): Date {
  return a < b ? a : b;
}
