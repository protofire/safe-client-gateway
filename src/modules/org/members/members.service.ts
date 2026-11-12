import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { ActivityLog } from '@/modules/org/activity/activity-log.service';
import { SecurityEvents } from '@/modules/org/auth/security-events';
import { SessionsRepository } from '@/modules/org/auth/sessions.repository';
import { Clock, type IClock } from '@/modules/org/common/clock';
import { RateLimiter } from '@/modules/org/common/rate-limiter';
import { FieldEncryptionService } from '@/modules/org/crypto/field-encryption.service';
import { OrgTransaction } from '@/modules/org/db/org-transaction';
import {
  ADMIN_PERMISSION,
  SecurityNotifier,
} from '@/modules/org/mail/security-notifier';
import { maskEmail, maskIdentity } from '@/modules/org/members/identity-mask';
import { memberRows, type MemberRow } from '@/modules/org/members/member-rows';
import {
  conflict,
  lockOrgs,
  mapLastAdmin,
  recheckPermission,
} from '@/modules/org/orgs/org-lock';
import type { Actor } from '@/modules/org/orgs/parse';
import {
  type EffectivePermissions,
  PermissionResolver,
} from '@/modules/org/permissions/permission.resolver';
import type { Permission } from '@/modules/org/permissions/permissions';
import type { SystemRoleKey } from '@/modules/org/permissions/role-keys';

export type MemberView = {
  id: string;
  userId: string | null;
  status: 'invited' | 'active' | 'declined';
  role: string | null;
  identity: { kind: 'wallet' | 'email'; value: string };
  invitedAt?: string;
  expiresAt?: string;
};

// Who sees member emails in full (A16): the same holders as for IPs in the activity log
const SEES_EMAILS: Permission = 'members.remove';
// Role changes can mail every admin (security notices): per acting user, all
// attempts, generous for real admin work but no mail cannon
const ROLE_CHANGES_PER_USER_PER_HOUR = 20;

export function toMemberView(
  row: MemberRow,
  viewer: { userId: string; permissions: Array<Permission> },
): MemberView {
  const full =
    viewer.permissions.includes(SEES_EMAILS) || row.userId === viewer.userId;
  return {
    id: row.id,
    userId: row.userId,
    status: row.status,
    role: row.role,
    identity:
      row.identity.kind === 'email' && !full
        ? { kind: 'email', value: maskEmail(row.identity.value) }
        : row.identity,
    ...(row.status === 'invited' && row.invitedAt
      ? { invitedAt: new Date(row.invitedAt).toISOString() }
      : {}),
    ...(row.status === 'invited' && row.expiresAt
      ? { expiresAt: new Date(row.expiresAt).toISOString() }
      : {}),
  };
}

/** A system role by key; 400 if unknown. */
export async function systemRole(
  em: Pick<EntityManager, 'query'>,
  key: SystemRoleKey,
): Promise<{ id: string; key: string; permissions: Array<string> }> {
  const [role] = await em.query(
    `SELECT id, key, permissions FROM roles WHERE org_id IS NULL AND key = $1`,
    [key],
  );
  if (!role) throw new BadRequestException('Unknown role');
  return role;
}

/** Spec §5: nobody grants a permission they do not hold. */
export function assertCanGrant(
  role: { permissions: Array<string> },
  held: Array<Permission>,
): void {
  if (!role.permissions.every((p) => (held as Array<string>).includes(p))) {
    throw new ForbiddenException('Cannot grant permissions you do not hold');
  }
}

/**
 * Item 11: an inviter who loses the right to invite (removed, demoted, left,
 * account deleted) takes their pending invitations in `orgId` along.
 * Deleting the invited member row cascades to its invitation and role binding.
 */
export async function revokeInvitationsBy(
  em: EntityManager,
  deps: { encryption: FieldEncryptionService; activity: ActivityLog },
  orgId: string,
  inviterUserId: string | null,
  reason: 'inviter_removed' | 'inviter_demoted' | 'inviter_left',
  by: Actor,
): Promise<void> {
  if (!inviterUserId) return;
  const pending: Array<{ id: string }> = await em.query(
    `SELECT DISTINCT m.id FROM members m
     JOIN invitations i ON i.member_id = m.id
     WHERE m.org_id = $1 AND m.status = 'invited' AND i.invited_by = $2
       AND i.accepted_at IS NULL AND i.declined_at IS NULL`,
    [orgId, inviterUserId],
  );
  for (const { id } of pending) {
    const [row] = await memberRows(em, deps.encryption, orgId, id);
    await em.query(`DELETE FROM members WHERE id = $1`, [id]);
    await deps.activity.record(em, {
      orgId,
      actorUserId: by.userId,
      type: 'member.invite_revoked',
      targetType: 'membership',
      targetId: id,
      payload: { target: maskIdentity(row.identity), reason },
      ip: by.ip,
      userAgent: by.userAgent,
    });
  }
}

@Injectable()
export class MembersService {
  constructor(
    private readonly tx: OrgTransaction,
    private readonly activity: ActivityLog,
    private readonly resolver: PermissionResolver,
    private readonly encryption: FieldEncryptionService,
    private readonly sessions: SessionsRepository,
    private readonly securityEvents: SecurityEvents,
    private readonly notifier: SecurityNotifier,
    private readonly rateLimiter: RateLimiter,
    @Inject(Clock) private readonly clock: IClock,
  ) {}

  async list(
    orgId: string,
    viewer: { userId: string; permissions: Array<Permission> },
  ): Promise<Array<MemberView>> {
    const rows = await this.tx.runInOrgTx((em) =>
      memberRows(em, this.encryption, orgId),
    );
    return rows.map((r) => toMemberView(r, viewer));
  }

  async changeRole(
    orgId: string,
    memberId: string,
    roleKey: SystemRoleKey,
    by: Actor,
  ): Promise<void> {
    await this.rateLimiter.enforce(
      `members:role:user:${by.userId}`,
      ROLE_CHANGES_PER_USER_PER_HOUR,
      3600,
    );
    const demoted = await this.underOrgLock(
      orgId,
      by.userId,
      'roles.assign',
      async (em, caller) => {
        const role = await systemRole(em, roleKey);
        assertCanGrant(role, caller.permissions);
        const member = await this.member(em, orgId, memberId);
        // an invitation's role is fixed (member) until it is accepted
        if (member.status !== 'active') {
          throw conflict('not_active', 'Only active members change role');
        }
        if (member.role === role.key) return null;
        await em.query(
          `DELETE FROM role_bindings WHERE member_id = $1 AND scope = 'org'`,
          [memberId],
        );
        await em.query(
          `INSERT INTO role_bindings (member_id, role_id) VALUES ($1, $2)`,
          [memberId, role.id],
        );
        await this.activity.record(em, {
          orgId,
          actorUserId: by.userId,
          type: 'member.role_changed',
          targetType: 'membership',
          targetId: memberId,
          payload: {
            target: maskIdentity(member.identity),
            from: member.role,
            to: role.key,
          },
          ip: by.ip,
          userAgent: by.userAgent,
        });
        if (!role.permissions.includes('members.invite')) {
          await this.revokeInvitationsBy(
            em,
            orgId,
            member,
            'inviter_demoted',
            by,
          );
        }
        return member.permissions.includes(ADMIN_PERMISSION) &&
          !role.permissions.includes(ADMIN_PERMISSION)
          ? member
          : null;
      },
    );
    if (demoted) {
      await this.notifier.notify(
        orgId,
        { kind: 'admin_demoted', target: maskIdentity(demoted.identity) },
        demoted.userId ? [demoted.userId] : [],
      );
    }
  }

  async remove(orgId: string, memberId: string, by: Actor): Promise<void> {
    const removed = await this.underOrgLock(
      orgId,
      by.userId,
      'members.remove',
      async (em) => {
        const member = await this.member(em, orgId, memberId);
        if (member.userId === by.userId) {
          throw new BadRequestException('Use leave to remove yourself');
        }
        await this.revokeInvitationsBy(
          em,
          orgId,
          member,
          'inviter_removed',
          by,
        );
        await em.query(`DELETE FROM members WHERE id = $1`, [memberId]);
        await this.activity.record(em, {
          orgId,
          actorUserId: by.userId,
          type: 'member.removed',
          targetType: 'membership',
          targetId: memberId,
          payload: { target: maskIdentity(member.identity) },
          ip: by.ip,
          userAgent: by.userAgent,
        });
        return member;
      },
    );
    if (removed.permissions.includes(ADMIN_PERMISSION)) {
      await this.notifier.notify(
        orgId,
        { kind: 'admin_removed', target: maskIdentity(removed.identity) },
        removed.userId ? [removed.userId] : [],
      );
    }
  }

  async leave(orgId: string, by: Actor): Promise<void> {
    await this.underOrgLock(
      orgId,
      by.userId,
      'org.view',
      async (em, caller) => {
        const member = await this.member(em, orgId, caller.memberId);
        await this.revokeInvitationsBy(em, orgId, member, 'inviter_left', by);
        await em.query(`DELETE FROM members WHERE id = $1`, [member.id]);
        await this.activity.record(em, {
          orgId,
          actorUserId: by.userId,
          type: 'member.left',
          targetType: 'membership',
          targetId: member.id,
          payload: { target: maskIdentity(member.identity) },
          ip: by.ip,
          userAgent: by.userAgent,
        });
      },
    );
  }

  /**
   * Amendment A8: only if the caller may reset factors in every org where the
   * target is an active member (else support must do it). Deletes the
   * target's TOTP factors and recovery codes and revokes all their sessions.
   */
  async resetFactors(
    orgId: string,
    memberId: string,
    by: Actor & { sessionId: string },
  ): Promise<void> {
    const { target, orgIds } = await this.tx.runInOrgTx(async (em) => {
      const found = await this.member(em, orgId, memberId);
      if (!found.userId) throw new NotFoundException();
      if (found.userId === by.userId) {
        throw new BadRequestException('Manage your own factors in settings');
      }
      // Lock order user rows (by id) → sessions, as in lockLinkingSession: the
      // audit row below takes KEY SHARE on the caller, so both are locked up
      // front; A resetting B while B resets A then serialises. No org lock.
      await em.query(
        `SELECT 1 FROM users WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
        [[found.userId, by.userId]],
      );
      // checked again under the locks: a change committed while we waited counts
      await recheckPermission(
        this.resolver,
        em,
        orgId,
        by.userId,
        'factors.reset',
      );
      const member = await this.member(em, orgId, memberId);
      if (member.status !== 'active' || member.userId !== found.userId) {
        throw new NotFoundException();
      }
      const [{ outside }]: Array<{ outside: number }> = await em.query(
        `SELECT count(*)::int AS outside FROM members t
         WHERE t.user_id = $1 AND t.status = 'active'
           AND NOT EXISTS (
             SELECT 1 FROM members c
             JOIN role_bindings rb ON rb.member_id = c.id AND rb.scope = 'org'
             JOIN roles r ON r.id = rb.role_id AND (r.org_id IS NULL OR r.org_id = c.org_id)
             WHERE c.org_id = t.org_id AND c.user_id = $2 AND c.status = 'active'
               AND 'factors.reset' = ANY(r.permissions))`,
        [member.userId, by.userId],
      );
      if (outside > 0) {
        throw new ForbiddenException({
          statusCode: 403,
          message:
            'The member belongs to organizations you do not administer; contact support',
          code: 'support_required',
        });
      }
      await em.query(`DELETE FROM factors WHERE user_id = $1`, [member.userId]);
      await em.query(`DELETE FROM recovery_codes WHERE user_id = $1`, [
        member.userId,
      ]);
      // every session of the target (the caller's own session is not theirs)
      await this.sessions.revokeOthers(
        member.userId,
        by.sessionId,
        this.clock.now(),
        em,
      );
      await this.activity.record(em, {
        orgId,
        actorUserId: by.userId,
        type: 'member.factors_reset',
        targetType: 'membership',
        targetId: memberId,
        payload: { target: maskIdentity(member.identity) },
        ip: by.ip,
        userAgent: by.userAgent,
      });
      // the reset is global: every org of the target hears about it
      const orgs: Array<{ orgId: string }> = await em.query(
        `SELECT org_id AS "orgId" FROM members WHERE user_id = $1 AND status = 'active'`,
        [member.userId],
      );
      return { target: member, orgIds: orgs.map((o) => o.orgId) };
    }, orgId);
    await this.securityEvents.record(target.userId!, 'security.totp_removed', {
      resetBy: by.userId,
    });
    await this.notifier.notify(
      orgId,
      { kind: 'factors_reset', target: maskIdentity(target.identity) },
      [target.userId!],
      orgIds,
    );
  }

  private revokeInvitationsBy(
    em: EntityManager,
    orgId: string,
    inviter: MemberRow,
    reason: 'inviter_removed' | 'inviter_demoted' | 'inviter_left',
    by: Actor,
  ): Promise<void> {
    return revokeInvitationsBy(
      em,
      { encryption: this.encryption, activity: this.activity },
      orgId,
      inviter.userId,
      reason,
      by,
    );
  }

  private async member(
    em: EntityManager,
    orgId: string,
    memberId: string,
  ): Promise<MemberRow> {
    const [member] = await memberRows(em, this.encryption, orgId, memberId);
    if (!member) throw new NotFoundException();
    return member;
  }

  /**
   * Amendment A4: locks the org row first, then re-checks that the caller
   * still holds `permission` (a concurrent change may have revoked it while
   * we waited; the guard checked before the wait). The last-admin trigger
   * and lock deadlocks map to 409 (`last_admin` / `retry`).
   */
  private async underOrgLock<T>(
    orgId: string,
    userId: string,
    permission: Permission,
    fn: (em: EntityManager, caller: EffectivePermissions) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.tx.runInOrgTx(async (em) => {
        await lockOrgs(em, [orgId]);
        // permission checked after the trigger below, see there
        const effective = await recheckPermission(
          this.resolver,
          em,
          orgId,
          userId,
          permission,
          { deferForbidden: true },
        );
        const result = await fn(em, effective);
        // Invariant before the permission recheck: when two admins demote or
        // remove each other, the one that waited sees 409 last_admin (A4)
        // rather than 403 for the role it just lost. Either way it rolls back.
        await em.query(`SET CONSTRAINTS members_keep_one_admin IMMEDIATE`);
        if (!effective.permissions.includes(permission)) {
          throw new ForbiddenException();
        }
        return result;
      }, orgId);
    } catch (error) {
      return mapLastAdmin(error);
    }
  }
}
