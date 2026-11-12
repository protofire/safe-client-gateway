import {
  ForbiddenException,
  GoneException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { IConfigurationService } from '@/config/configuration.service.interface';
import {
  type ILoggingService,
  LoggingService,
} from '@/logging/logging.interface';
import { ActivityLog } from '@/modules/org/activity/activity-log.service';
import { Clock, type IClock } from '@/modules/org/common/clock';
import { RateLimiter } from '@/modules/org/common/rate-limiter';
import { FieldEncryptionService } from '@/modules/org/crypto/field-encryption.service';
import {
  generateToken,
  hmacEmail,
  normalizeEmail,
  sha256Hex,
} from '@/modules/org/crypto/hashing';
import { OrgTransaction } from '@/modules/org/db/org-transaction';
import {
  mailFailureReason,
  MailService,
} from '@/modules/org/mail/mail.service';
import {
  maskIdentity,
  type MemberIdentity,
} from '@/modules/org/members/identity-mask';
import { memberRows } from '@/modules/org/members/member-rows';
import {
  assertCanGrant,
  systemRole,
  toMemberView,
  type MemberView,
} from '@/modules/org/members/members.service';
import {
  conflict,
  lockOrgs,
  recheckPermission,
} from '@/modules/org/orgs/org-lock';
import { assertOrgLimit } from '@/modules/org/orgs/orgs.service';
import type { Actor } from '@/modules/org/orgs/parse';
import { PermissionResolver } from '@/modules/org/permissions/permission.resolver';
import type { Permission } from '@/modules/org/permissions/permissions';
import { INVITATION_ROLE_KEY } from '@/modules/org/permissions/role-keys';

export const MAX_MEMBERS_PER_ORG = 100;
const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;
const INVITES_PER_HOUR = 30;
// per inviting user across all their orgs (up to 10): 2 orgs' worth, so one
// account cannot turn 10 x 30 into a mail cannon (item 7)
const INVITES_PER_USER_PER_HOUR = 60;

export type InviteTarget = { wallet: string } | { email: string };

type Invitation = {
  id: string;
  orgId: string;
  memberId: string;
  targetKind: 'wallet' | 'email';
  targetWallet: string | null;
  targetEmailHash: string | null;
  targetEmailEncrypted: string | null;
  expiresAt: Date;
  acceptedAt: Date | null;
  declinedAt: Date | null;
};

const INVITATION_COLUMNS = `i.id, i.org_id AS "orgId", i.member_id AS "memberId",
  i.target_kind AS "targetKind", i.target_wallet AS "targetWallet",
  i.target_email_hash AS "targetEmailHash", i.target_email_encrypted AS "targetEmailEncrypted",
  i.expires_at AS "expiresAt", i.accepted_at AS "acceptedAt", i.declined_at AS "declinedAt"`;

// The caller's identities match the invitation target ($1 = user id)
const MATCHES_CALLER = `(
  i.target_wallet IN (SELECT wallet_address FROM identities WHERE user_id = $1 AND kind = 'wallet')
  OR i.target_email_hash IN (SELECT email_hash FROM identities WHERE user_id = $1 AND kind = 'oidc'))`;

function invalidInvitation(): NotFoundException {
  return new NotFoundException({
    statusCode: 404,
    message: 'Invitation not found or already used',
    code: 'invitation_invalid',
  });
}

@Injectable()
export class InvitationsService {
  private readonly emailHashKey: Buffer;
  private readonly appUrl: string;

  constructor(
    private readonly tx: OrgTransaction,
    private readonly activity: ActivityLog,
    private readonly resolver: PermissionResolver,
    private readonly encryption: FieldEncryptionService,
    private readonly rateLimiter: RateLimiter,
    private readonly mail: MailService,
    @Inject(Clock) private readonly clock: IClock,
    @Inject(IConfigurationService) config: IConfigurationService,
    @Inject(LoggingService) private readonly logger: ILoggingService,
  ) {
    this.emailHashKey = Buffer.from(
      config.getOrThrow<string>('org.emailHashKey'),
      'base64',
    );
    this.appUrl = config.getOrThrow<string>('org.publicAppUrl');
  }

  async invite(
    orgId: string,
    target: InviteTarget,
    by: Actor,
  ): Promise<MemberView & { emailSent?: boolean }> {
    await this.limitInvites(orgId, by.userId);
    const now = this.clock.now();
    const token = generateToken();
    const email = 'email' in target ? normalizeEmail(target.email) : null;
    const wallet = 'wallet' in target ? target.wallet : null;
    const emailHash = email ? hmacEmail(email, this.emailHashKey) : null;

    const { member, orgName } = await this.tx.runInOrgTx(async (em) => {
      const caller = await this.lockAndCheck(em, orgId, by.userId);
      const role = await systemRole(em, INVITATION_ROLE_KEY);
      assertCanGrant(role, caller.permissions);

      const [{ count }]: Array<{ count: number }> = await em.query(
        `SELECT count(*)::int AS count FROM members
         WHERE org_id = $1 AND status IN ('active', 'invited')`,
        [orgId],
      );
      if (count >= MAX_MEMBERS_PER_ORG) {
        throw conflict(
          'member_limit',
          `An organization can have at most ${MAX_MEMBERS_PER_ORG} members, including invited`,
        );
      }
      const [pending] = await em.query(
        `SELECT 1 FROM invitations i JOIN members m ON m.id = i.member_id AND m.status = 'invited'
         WHERE i.org_id = $1 AND i.accepted_at IS NULL AND i.declined_at IS NULL
           AND (i.target_wallet = $2 OR i.target_email_hash = $3)`,
        [orgId, wallet, emailHash],
      );
      if (pending) {
        throw conflict(
          'already_invited',
          'Already invited; renew the invitation',
        );
      }
      // an existing user with this identity: active → refuse, declined → re-invite the same row
      const [existing]: Array<{ id: string; status: string }> = await em.query(
        `SELECT m.id, m.status FROM members m
         JOIN identities idn ON idn.user_id = m.user_id
         WHERE m.org_id = $1
           AND ((idn.kind = 'wallet' AND idn.wallet_address = $2)
             OR (idn.kind = 'oidc' AND idn.email_hash = $3))
         ORDER BY (m.status = 'active') DESC LIMIT 1`,
        [orgId, wallet, emailHash],
      );
      if (existing?.status === 'active') {
        throw conflict('already_member', 'Already a member');
      }
      let memberId: string;
      if (existing) {
        memberId = existing.id;
        await em.query(
          `UPDATE members SET status = 'invited', updated_at = $2 WHERE id = $1`,
          [memberId, now],
        );
        await em.query(
          `DELETE FROM role_bindings WHERE member_id = $1 AND scope = 'org'`,
          [memberId],
        );
      } else {
        [{ id: memberId }] = await em.query(
          `INSERT INTO members (org_id, status) VALUES ($1, 'invited') RETURNING id`,
          [orgId],
        );
      }
      await em.query(
        `INSERT INTO role_bindings (member_id, role_id) VALUES ($1, $2)`,
        [memberId, role.id],
      );
      await em.query(
        `INSERT INTO invitations (org_id, member_id, target_kind, target_wallet,
           target_email_hash, target_email_encrypted, token_hash, invited_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          orgId,
          memberId,
          wallet ? 'wallet' : 'email',
          wallet,
          emailHash,
          email ? this.encryption.encrypt(email) : null,
          sha256Hex(token),
          by.userId,
          new Date(now.getTime() + INVITE_TTL_MS),
        ],
      );
      const [row] = await memberRows(em, this.encryption, orgId, memberId);
      await this.activity.record(em, {
        orgId,
        actorUserId: by.userId,
        type: 'member.invited',
        targetType: 'membership',
        targetId: memberId,
        payload: { target: maskIdentity(row.identity), role: role.key },
        ip: by.ip,
        userAgent: by.userAgent,
      });
      return { member: row, orgName: await this.orgName(em, orgId) };
    }, orgId);

    const view = toMemberView(member, {
      userId: by.userId,
      permissions:
        (await this.resolver.effective(orgId, by.userId))?.permissions ?? [],
    });
    if (!email) return view;
    return {
      ...view,
      emailSent: await this.sendInvite(email, token, orgName, by.userId),
    };
  }

  /** New token and expiry; the old token stops working (A9). */
  async renew(
    orgId: string,
    memberId: string,
    by: Actor,
  ): Promise<{ expiresAt: string; emailSent?: boolean }> {
    await this.limitInvites(orgId, by.userId);
    const now = this.clock.now();
    const token = generateToken();
    const result = await this.tx.runInOrgTx(async (em) => {
      await this.lockAndCheck(em, orgId, by.userId);
      // UPDATE … RETURNING resolves to [rows, affected] in TypeORM's postgres driver
      const [[renewed]]: [
        Array<{ expiresAt: Date; targetEmailEncrypted: string | null }>,
        number,
      ] = await em.query(
        `UPDATE invitations i SET token_hash = $3, expires_at = $4, updated_at = $5
           FROM members m
           WHERE m.id = i.member_id AND m.status = 'invited'
             AND i.member_id = $1 AND i.org_id = $2
             AND i.accepted_at IS NULL AND i.declined_at IS NULL
           RETURNING i.expires_at AS "expiresAt", i.target_email_encrypted AS "targetEmailEncrypted"`,
        [
          memberId,
          orgId,
          sha256Hex(token),
          new Date(now.getTime() + INVITE_TTL_MS),
          now,
        ],
      );
      if (!renewed) throw new NotFoundException();
      const [row] = await memberRows(em, this.encryption, orgId, memberId);
      await this.activity.record(em, {
        orgId,
        actorUserId: by.userId,
        type: 'member.invite_renewed',
        targetType: 'membership',
        targetId: memberId,
        payload: { target: maskIdentity(row.identity) },
        ip: by.ip,
        userAgent: by.userAgent,
      });
      return { renewed, orgName: await this.orgName(em, orgId) };
    }, orgId);
    const expiresAt = new Date(result.renewed.expiresAt).toISOString();
    if (!result.renewed.targetEmailEncrypted) return { expiresAt };
    return {
      expiresAt,
      emailSent: await this.sendInvite(
        this.encryption.decrypt(result.renewed.targetEmailEncrypted),
        token,
        result.orgName,
        by.userId,
      ),
    };
  }

  acceptByToken(token: string, by: Actor): Promise<{ orgId: string }> {
    return this.answer('accept', { token }, by);
  }

  declineByToken(token: string, by: Actor): Promise<{ orgId: string }> {
    return this.answer('decline', { token }, by);
  }

  /** A pending invitation of `orgId` addressed to one of the caller's identities. */
  acceptById(orgId: string, by: Actor): Promise<{ orgId: string }> {
    return this.answer('accept', { orgId }, by);
  }

  declineById(orgId: string, by: Actor): Promise<{ orgId: string }> {
    return this.answer('decline', { orgId }, by);
  }

  private async answer(
    action: 'accept' | 'decline',
    ref: { token: string } | { orgId: string },
    by: Actor,
  ): Promise<{ orgId: string }> {
    const now = this.clock.now();
    const tokenHash = 'token' in ref ? sha256Hex(ref.token) : null;
    const invitation = await this.find(ref, tokenHash, by.userId, now);

    return this.tx.runInOrgTx(async (em) => {
      const [org] = await lockOrgs(em, [invitation.orgId]);
      const [{ status }]: Array<{ status: string }> = org
        ? await em.query(`SELECT status FROM organizations WHERE id = $1`, [
            org,
          ])
        : [{ status: 'gone' }];
      if (status !== 'active') throw invalidInvitation();
      // The caller's account may have been deleted while we waited; the row
      // lock also makes a later account deletion wait for this commit, after
      // which it deletes the new membership too.
      const [caller]: Array<{ status: string }> = await em.query(
        `SELECT status FROM users WHERE id = $1 FOR NO KEY UPDATE`,
        [by.userId],
      );
      if (caller?.status !== 'active') throw new UnauthorizedException();

      // A9: single use, decided under the org lock by this conditional update;
      // by token, a renew committed since find() has rotated it: refused
      const [[claimed]]: [Array<{ id: string }>, number] = await em.query(
        `UPDATE invitations SET ${action === 'accept' ? 'accepted_at' : 'declined_at'} = $2, updated_at = $2
         WHERE id = $1 AND accepted_at IS NULL AND declined_at IS NULL AND expires_at > $2
           AND ($3::text IS NULL OR token_hash = $3)
         RETURNING id`,
        [invitation.id, now, tokenHash],
      );
      if (!claimed) {
        throw invitation.expiresAt <= now ? expired() : invalidInvitation();
      }

      const [target] = await memberRows(
        em,
        this.encryption,
        invitation.orgId,
        invitation.memberId,
      );
      if (!target || target.status !== 'invited') throw invalidInvitation();
      const [other]: Array<{ id: string; status: string }> = await em.query(
        `SELECT id, status FROM members WHERE org_id = $1 AND user_id = $2 AND id <> $3`,
        [invitation.orgId, by.userId, invitation.memberId],
      );
      if (other?.status === 'active') {
        // e.g. invited by wallet and by email: one membership is enough
        await em.query(`DELETE FROM members WHERE id = $1`, [
          invitation.memberId,
        ]);
        return { orgId: invitation.orgId };
      }
      if (action === 'accept') {
        await assertOrgLimit(em, by.userId);
        // invitations always grant member, also ones stored with another
        // role before that rule (legacy admin invitations)
        const role = await systemRole(em, INVITATION_ROLE_KEY);
        await em.query(
          `DELETE FROM role_bindings WHERE member_id = $1 AND scope = 'org'`,
          [invitation.memberId],
        );
        await em.query(
          `INSERT INTO role_bindings (member_id, role_id) VALUES ($1, $2)`,
          [invitation.memberId, role.id],
        );
      }
      // upsert: the invited row becomes the caller's only row in this org
      if (other)
        await em.query(`DELETE FROM members WHERE id = $1`, [other.id]);
      await em.query(
        `UPDATE members SET user_id = $2, status = $3, updated_at = $4 WHERE id = $1`,
        [
          invitation.memberId,
          by.userId,
          action === 'accept' ? 'active' : 'declined',
          now,
        ],
      );
      await this.activity.record(em, {
        orgId: invitation.orgId,
        actorUserId: by.userId,
        type: action === 'accept' ? 'member.joined' : 'member.declined',
        targetType: 'membership',
        targetId: invitation.memberId,
        payload: { target: maskIdentity(target.identity) },
        ip: by.ip,
        userAgent: by.userAgent,
      });
      return { orgId: invitation.orgId };
    }, invitation.orgId);
  }

  /**
   * By token: the invitation, then the identity check (403 identity_mismatch
   * with the masked target). By org: a pending invitation addressed to the
   * caller, else 404.
   */
  private async find(
    ref: { token: string } | { orgId: string },
    tokenHash: string | null,
    userId: string,
    now: Date,
  ): Promise<Invitation> {
    if (!tokenHash) {
      const [invitation]: Array<Invitation> = await this.tx.runInOrgTx((em) =>
        em.query(
          `SELECT ${INVITATION_COLUMNS} FROM invitations i
           JOIN members m ON m.id = i.member_id AND m.status = 'invited'
           WHERE i.org_id = $2 AND i.accepted_at IS NULL AND i.declined_at IS NULL
             AND i.expires_at > $3 AND ${MATCHES_CALLER}
             -- A9: only wallet invitations are answered by org id; email ones need the token
             AND i.target_kind = 'wallet'
           ORDER BY i.created_at DESC LIMIT 1`,
          [userId, (ref as { orgId: string }).orgId, now],
        ),
      );
      if (!invitation) throw new NotFoundException();
      return invitation;
    }
    const [invitation]: Array<Invitation & { matches: boolean }> =
      await this.tx.runInOrgTx((em) =>
        em.query(
          `SELECT ${INVITATION_COLUMNS}, ${MATCHES_CALLER} AS matches
           FROM invitations i WHERE i.token_hash = $2`,
          [userId, tokenHash],
        ),
      );
    if (!invitation || invitation.acceptedAt || invitation.declinedAt) {
      throw invalidInvitation();
    }
    if (!invitation.matches) {
      const identity: MemberIdentity = invitation.targetWallet
        ? { kind: 'wallet', value: invitation.targetWallet }
        : {
            kind: 'email',
            value: this.encryption.decrypt(invitation.targetEmailEncrypted!),
          };
      throw new ForbiddenException({
        statusCode: 403,
        message: 'Sign in with the identity this invitation was sent to',
        code: 'identity_mismatch',
        target: maskIdentity(identity),
      });
    }
    if (new Date(invitation.expiresAt) <= now) throw expired();
    return invitation;
  }

  /** Org lock (A9: limits under it) and a fresh members.invite check. */
  private async lockAndCheck(
    em: EntityManager,
    orgId: string,
    userId: string,
  ): Promise<{ permissions: Array<Permission> }> {
    await lockOrgs(em, [orgId]);
    return recheckPermission(
      this.resolver,
      em,
      orgId,
      userId,
      'members.invite',
    );
  }

  private async orgName(em: EntityManager, orgId: string): Promise<string> {
    const [{ name }] = await em.query(
      `SELECT name FROM organizations WHERE id = $1`,
      [orgId],
    );
    return name;
  }

  /**
   * Every attempt counts: the user's counter first; a user over their limit
   * is refused before the org's counter is charged, so one admin cannot use
   * up the org's budget for the others.
   */
  private async limitInvites(orgId: string, userId: string): Promise<void> {
    const allowed =
      (await this.rateLimiter.hit(
        `invitations:user:${userId}`,
        INVITES_PER_USER_PER_HOUR,
        3600,
      )) &&
      (await this.rateLimiter.hit(
        `invitations:org:${orgId}`,
        INVITES_PER_HOUR,
        3600,
      ));
    if (!allowed) {
      throw new HttpException(
        { statusCode: 429, message: 'Too many invitations' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /** After commit: a mail failure leaves the invitation in place (renew resends). */
  private async sendInvite(
    to: string,
    token: string,
    orgName: string,
    inviterId: string,
  ): Promise<boolean> {
    // token in the fragment: never sent to a server or kept in access logs (UI UA5)
    const acceptUrl = `${this.appUrl}/organizations/invite#token=${token}`;
    try {
      const inviterLabel = await this.inviterLabel(inviterId);
      await this.mail.sendInvite(to, { orgName, inviterLabel, acceptUrl });
      return true;
    } catch (error) {
      this.logger.error(`invitation mail failed: ${mailFailureReason(error)}`);
      return false;
    }
  }

  private async inviterLabel(userId: string): Promise<string> {
    const [row]: Array<{ wallet: string | null; email: string | null }> =
      await this.tx.runInOrgTx((em) =>
        em.query(
          `SELECT
             (SELECT wallet_address FROM identities WHERE user_id = $1 AND kind = 'wallet' ORDER BY created_at LIMIT 1) AS wallet,
             (SELECT email_encrypted FROM identities WHERE user_id = $1 AND kind = 'oidc' AND email_encrypted IS NOT NULL ORDER BY created_at LIMIT 1) AS email`,
          [userId],
        ),
      );
    if (row?.wallet) return maskIdentity({ kind: 'wallet', value: row.wallet });
    if (row?.email) {
      return maskIdentity({
        kind: 'email',
        value: this.encryption.decrypt(row.email),
      });
    }
    return 'An organization admin';
  }
}

function expired(): GoneException {
  return new GoneException({
    statusCode: 410,
    message: 'Invitation expired; ask an admin to renew it',
    code: 'invitation_expired',
  });
}
