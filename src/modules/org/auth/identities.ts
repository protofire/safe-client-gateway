import type { EntityManager } from 'typeorm';
import { conflict } from '@/modules/org/orgs/org-lock';

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
