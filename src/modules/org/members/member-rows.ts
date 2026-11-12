import type { EntityManager } from 'typeorm';
import type { FieldEncryptionService } from '@/modules/org/crypto/field-encryption.service';
import type { MemberIdentity } from '@/modules/org/members/identity-mask';

type Row = {
  id: string;
  userId: string | null;
  status: 'invited' | 'active' | 'declined';
  role: string | null;
  permissions: Array<string> | null;
  wallet: string | null;
  emailEncrypted: string | null;
  targetWallet: string | null;
  targetEmailEncrypted: string | null;
  invitedAt: Date | null;
  expiresAt: Date | null;
};

export type MemberRow = {
  id: string;
  userId: string | null;
  status: 'invited' | 'active' | 'declined';
  role: string | null;
  /** Permissions of `role`; empty without a role. */
  permissions: Array<string>;
  identity: MemberIdentity;
  invitedAt: Date | null;
  expiresAt: Date | null;
};

/**
 * Members of an org (or one member) with role key, identity and latest
 * invitation. Identity: the pending invitation's target for invited members,
 * otherwise the user's first wallet, else their first verified email.
 */
export async function memberRows(
  em: Pick<EntityManager, 'query'>,
  encryption: FieldEncryptionService,
  orgId: string,
  memberId: string | null = null,
): Promise<Array<MemberRow>> {
  const rows: Array<Row> = await em.query(
    `SELECT m.id, m.user_id AS "userId", m.status, role.key AS role, role.permissions,
       w.wallet_address AS wallet, e.email_encrypted AS "emailEncrypted",
       i.target_wallet AS "targetWallet", i.target_email_encrypted AS "targetEmailEncrypted",
       i.created_at AS "invitedAt", i.expires_at AS "expiresAt"
     FROM members m
     LEFT JOIN LATERAL (
       SELECT r.key, r.permissions FROM role_bindings rb JOIN roles r ON r.id = rb.role_id
       WHERE rb.member_id = m.id AND rb.scope = 'org'
         AND (r.org_id IS NULL OR r.org_id = m.org_id)
       ORDER BY r.key LIMIT 1) role ON true
     LEFT JOIN LATERAL (
       SELECT wallet_address FROM identities
       WHERE user_id = m.user_id AND kind = 'wallet' ORDER BY created_at, id LIMIT 1) w ON true
     LEFT JOIN LATERAL (
       SELECT email_encrypted FROM identities
       WHERE user_id = m.user_id AND kind = 'oidc' AND email_encrypted IS NOT NULL
       ORDER BY created_at, id LIMIT 1) e ON true
     LEFT JOIN LATERAL (
       SELECT target_wallet, target_email_encrypted, created_at, expires_at FROM invitations
       WHERE member_id = m.id ORDER BY created_at DESC, id LIMIT 1) i ON true
     WHERE m.org_id = $1 AND ($2::uuid IS NULL OR m.id = $2)
     ORDER BY m.created_at, m.id`,
    [orgId, memberId],
  );
  return rows.map((r) => {
    const fromInvite =
      r.status === 'invited' || (!r.wallet && !r.emailEncrypted);
    const wallet = fromInvite ? r.targetWallet : r.wallet;
    const email = fromInvite ? r.targetEmailEncrypted : r.emailEncrypted;
    const identity: MemberIdentity = wallet
      ? { kind: 'wallet', value: wallet }
      : { kind: 'email', value: email ? encryption.decrypt(email) : '' };
    return {
      id: r.id,
      userId: r.userId,
      status: r.status,
      role: r.role,
      permissions: r.permissions ?? [],
      identity,
      invitedAt: r.invitedAt,
      expiresAt: r.expiresAt,
    };
  });
}
