import { ForbiddenException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { conflict } from '@/modules/org/orgs/org-lock';

/**
 * Lock order for every transaction that changes a user's identities,
 * factors or sessions: the user row first, then session rows. Locks the
 * user (must be active: account deletion updates it under the same lock),
 * then the linking session, which must still be live, the user's and
 * strong-fresh; 403 `reauth_required` otherwise. A concurrent revocation
 * or deletion either commits first (seen here) or waits for this one.
 */
export async function lockLinkingSession(
  em: Pick<EntityManager, 'query'>,
  args: {
    userId: string;
    sessionId: string;
    now: Date;
    strongWindowMs: number;
  },
): Promise<void> {
  const { userId, sessionId, now, strongWindowMs } = args;
  const [user]: Array<{ status: string }> = await em.query(
    `SELECT status FROM users WHERE id = $1 FOR UPDATE`,
    [userId],
  );
  const [session]: Array<{ lastStrongAuthAt: Date | null }> =
    user?.status === 'active'
      ? await em.query(
          `SELECT last_strong_auth_at AS "lastStrongAuthAt" FROM sessions
           WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
             AND expires_at > $3 AND idle_expires_at > $3
           FOR UPDATE`,
          [sessionId, userId, now],
        )
      : [];
  const strong = session?.lastStrongAuthAt;
  if (!strong || now.getTime() - strong.getTime() > strongWindowMs) {
    throw new ForbiddenException({
      statusCode: 403,
      message: 'Sign in again and confirm with a strong factor to link',
      code: 'reauth_required',
    });
  }
}

export type NewIdentity =
  | { kind: 'wallet'; walletAddress: string }
  | {
      kind: 'oidc';
      issuer: string;
      subject: string;
      emailEncrypted: string;
      emailHash: string;
    };

/**
 * Adds an identity to `userId` (Task 12 linking). Returns false when it
 * already was this user's; 409 `identity_taken` when it is another user's.
 */
export async function attachIdentity(
  em: Pick<EntityManager, 'query'>,
  userId: string,
  identity: NewIdentity,
): Promise<boolean> {
  const inserted: Array<{ id: string }> =
    identity.kind === 'wallet'
      ? await em.query(
          `INSERT INTO identities (user_id, kind, wallet_address) VALUES ($1, 'wallet', $2)
           ON CONFLICT (wallet_address) WHERE kind = 'wallet' DO NOTHING RETURNING id`,
          [userId, identity.walletAddress],
        )
      : await em.query(
          `INSERT INTO identities (user_id, kind, oidc_issuer, oidc_subject, email_encrypted, email_hash)
           VALUES ($1, 'oidc', $2, $3, $4, $5)
           ON CONFLICT (oidc_issuer, oidc_subject) DO NOTHING RETURNING id`,
          [
            userId,
            identity.issuer,
            identity.subject,
            identity.emailEncrypted,
            identity.emailHash,
          ],
        );
  if (inserted.length > 0) return true;

  const [owner]: Array<{ userId: string }> =
    identity.kind === 'wallet'
      ? await em.query(
          `SELECT user_id AS "userId" FROM identities WHERE kind = 'wallet' AND wallet_address = $1`,
          [identity.walletAddress],
        )
      : await em.query(
          `SELECT user_id AS "userId" FROM identities WHERE kind = 'oidc' AND oidc_issuer = $1 AND oidc_subject = $2`,
          [identity.issuer, identity.subject],
        );
  if (owner?.userId === userId) return false;
  throw conflict('identity_taken', 'This identity belongs to another account');
}
