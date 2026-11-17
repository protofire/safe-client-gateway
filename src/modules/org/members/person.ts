import type { EntityManager } from 'typeorm';
import type { FieldEncryptionService } from '@/modules/org/crypto/field-encryption.service';
import { maskIdentity } from '@/modules/org/members/identity-mask';

/**
 * A person as other users see them: display name (read at request time) and
 * masked first wallet, else first email. Both null for a deleted user.
 */
export type PersonRef = {
  userId: string;
  displayName: string | null;
  identity: string | null;
};

/** {@link PersonRef} per user id; ids not found are absent. */
export async function people(
  em: Pick<EntityManager, 'query'>,
  encryption: FieldEncryptionService,
  userIds: Array<string | null>,
): Promise<Map<string, PersonRef>> {
  const ids = [...new Set(userIds.filter((id): id is string => id !== null))];
  if (ids.length === 0) return new Map();
  const rows: Array<{
    id: string;
    displayName: string | null;
    wallet: string | null;
    email: string | null;
  }> = await em.query(
    `SELECT u.id, CASE WHEN u.status = 'active' THEN u.display_name END AS "displayName",
       (SELECT wallet_address FROM identities WHERE user_id = u.id AND kind = 'wallet'
         ORDER BY created_at, id LIMIT 1) AS wallet,
       (SELECT email_encrypted FROM identities WHERE user_id = u.id AND kind = 'oidc'
         AND email_encrypted IS NOT NULL ORDER BY created_at, id LIMIT 1) AS email
     FROM users u WHERE u.id = ANY($1::uuid[])`,
    [ids],
  );
  const masked = (r: (typeof rows)[number]): string | null => {
    if (r.wallet) return maskIdentity({ kind: 'wallet', value: r.wallet });
    if (r.email) {
      return maskIdentity({ kind: 'email', value: encryption.decrypt(r.email) });
    }
    return null;
  };
  return new Map(
    rows.map((r) => [
      r.id,
      { userId: r.id, displayName: r.displayName, identity: masked(r) },
    ]),
  );
}

/** `people` for one id; null for null or unknown. */
export async function person(
  em: Pick<EntityManager, 'query'>,
  encryption: FieldEncryptionService,
  userId: string | null,
): Promise<PersonRef | null> {
  return (await people(em, encryption, [userId])).get(userId ?? '') ?? null;
}
