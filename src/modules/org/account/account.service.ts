import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { ActivityLog } from '@/modules/org/activity/activity-log.service';
import type { OrgSession } from '@/modules/org/auth/decorators';
import { SecurityEvents } from '@/modules/org/auth/security-events';
import { SessionsRepository } from '@/modules/org/auth/sessions.repository';
import { Clock, type IClock } from '@/modules/org/common/clock';
import { RateLimiter } from '@/modules/org/common/rate-limiter';
import { FieldEncryptionService } from '@/modules/org/crypto/field-encryption.service';
import { OrgTransaction } from '@/modules/org/db/org-transaction';
import { revokeInvitationsBy } from '@/modules/org/members/members.service';
import {
  conflict,
  lockOrgs,
  mapLastAdmin,
  pgFields,
} from '@/modules/org/orgs/org-lock';

const DISPLAY_NAME_CHANGES_PER_HOUR = 5;
const CHECK_VIOLATION = '23514';

/**
 * Account deletion (spec §6). The user row stays with status `deleted`, so
 * activity rows keep `actor_user_id` and render as "Deleted user"; their
 * IP and device fields are erased.
 */
@Injectable()
export class AccountService {
  constructor(
    private readonly tx: OrgTransaction,
    private readonly activity: ActivityLog,
    @Inject(Clock) private readonly clock: IClock,
    private readonly sessions: SessionsRepository,
    private readonly securityEvents: SecurityEvents,
    private readonly encryption: FieldEncryptionService,
    private readonly rateLimiter: RateLimiter,
  ) {}

  /**
   * 409 `last_identity` for the only identity; 404 if it is not the user's.
   * Ruling: removing the last wallet of a user without confirmed TOTP is
   * allowed; StrongAuthGuard then answers `totp_required` until they enrol.
   * Ends the user's other sessions.
   */
  async removeIdentity(
    session: OrgSession,
    identityId: string,
    client: { ip: string; userAgent: string | null },
  ): Promise<void> {
    const kind = await this.tx.runInOrgTx(async (em) => {
      // serialises concurrent removals, so two cannot both see a spare one
      await em.query(`SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, [
        session.userId,
      ]);
      const rows: Array<{ id: string; kind: string }> = await em.query(
        `SELECT id, kind FROM identities WHERE user_id = $1`,
        [session.userId],
      );
      const target = rows.find((r) => r.id === identityId);
      if (!target) throw new NotFoundException();
      if (rows.length === 1) {
        throw conflict(
          'last_identity',
          'An account must keep at least one sign-in method',
        );
      }
      await em.query(`DELETE FROM identities WHERE id = $1`, [identityId]);
      await this.sessions.revokeOthers(
        session.userId,
        session.sessionId,
        this.clock.now(),
        em,
      );
      return target.kind;
    });
    await this.securityEvents.record(
      session.userId,
      'security.identity_removed',
      { kind },
      client.ip,
      client.userAgent,
    );
  }

  /** Audited without the names: activity payloads outlive account deletion. */
  async setDisplayName(
    userId: string,
    displayName: string | null,
    client: { ip: string; userAgent: string | null },
  ): Promise<{ displayName: string | null }> {
    // every attempt counts: renames show in every org's activity log
    const limitKey = `account:display-name:user:${userId}`;
    await this.rateLimiter.enforce(
      limitKey,
      DISPLAY_NAME_CHANGES_PER_HOUR,
      3600,
    );
    try {
      await this.write(userId, displayName, client);
    } catch (error) {
      // The DB check freezes Unicode 18 sets; the runtime's regexes may be
      // older (Node 24.11: Unicode 16). Their disagreement is a 400 like any
      // other invalid name, not a 500, and not a spent attempt.
      const { code, constraint } = pgFields(error);
      if (
        code === CHECK_VIOLATION &&
        constraint?.startsWith('users_display_name_')
      ) {
        await this.rateLimiter.refund(limitKey);
        throw new BadRequestException('Invalid display name');
      }
      throw error;
    }
    return { displayName };
  }

  private async write(
    userId: string,
    displayName: string | null,
    client: { ip: string; userAgent: string | null },
  ): Promise<void> {
    await this.tx.runInOrgTx(async (em) => {
      const [user]: Array<{ displayName: string | null }> = await em.query(
        `SELECT display_name AS "displayName" FROM users
         WHERE id = $1 AND status = 'active' FOR NO KEY UPDATE`,
        [userId],
      );
      if (!user) throw new NotFoundException();
      if (user.displayName === displayName) return;
      await em.query(
        `UPDATE users SET display_name = $2, updated_at = $3 WHERE id = $1`,
        [userId, displayName, this.clock.now()],
      );
      await this.securityEvents.record(
        userId,
        'security.display_name_changed',
        { cleared: displayName === null },
        client.ip,
        client.userAgent,
        em,
      );
    });
  }

  /**
   * `confirm` runs in the deletion's transaction after the last-admin check
   * (so a refused deletion does not spend a TOTP or recovery code); a wrong
   * proof rolls everything back.
   */
  async delete(
    userId: string,
    confirm: (em: EntityManager) => Promise<void> = async () => {},
  ): Promise<void> {
    const now = this.clock.now();
    try {
      await this.tx.runInOrgTx(async (em) => {
        // A4: every org the user has a row in, locked in id order, before
        // the membership deletes the last-admin trigger checks at commit
        const read = (): Promise<Array<{ orgId: string; status: string }>> =>
          em.query(
            `SELECT org_id AS "orgId", status FROM members WHERE user_id = $1`,
            [userId],
          );
        let memberships = await read();
        const locked = new Set<string>();
        // a membership committed while we waited (e.g. an accept) gets its
        // org locked too; shortcut: gives up after 3 rounds and relies on the
        // last-admin trigger, raise if accounts join orgs that fast
        for (let round = 0; round < 3; round++) {
          const fresh = [...new Set(memberships.map((m) => m.orgId))].filter(
            (id) => !locked.has(id),
          );
          if (fresh.length === 0) break;
          await lockOrgs(em, fresh);
          fresh.forEach((id) => locked.add(id));
          memberships = await read();
        }
        // UPDATE … RETURNING resolves to [rows, affected] in TypeORM's postgres driver
        const [[user]]: [Array<{ id: string }>, number] = await em.query(
          `UPDATE users SET status = 'deleted', deleted_at = $2, updated_at = $2, display_name = NULL
           WHERE id = $1 AND status = 'active' RETURNING id`,
          [userId, now],
        );
        if (!user) return;
        for (const { orgId } of memberships.filter(
          (m) => m.status === 'active',
        )) {
          // like leaving: the user's pending invitations go with them
          await revokeInvitationsBy(
            em,
            { encryption: this.encryption, activity: this.activity },
            orgId,
            userId,
            'inviter_left',
            { userId },
          );
          await this.activity.record(em, {
            orgId,
            actorUserId: userId,
            type: 'member.left',
            payload: { target: 'Deleted user', reason: 'account_deleted' },
          });
        }
        await em.query(`DELETE FROM members WHERE user_id = $1`, [userId]);
        // the last-admin trigger checks now instead of at commit, so a
        // refused deletion fails before `confirm` spends a code
        await em.query(`SET CONSTRAINTS members_keep_one_admin IMMEDIATE`);
        await confirm(em);
        for (const table of [
          'identities',
          'factors',
          'recovery_codes',
          'sessions',
          'user_security_events',
        ]) {
          await em.query(`DELETE FROM ${table} WHERE user_id = $1`, [userId]);
        }
        await em.query(
          `UPDATE activity_events SET ip_encrypted = NULL, user_agent = NULL
           WHERE actor_user_id = $1`,
          [userId],
        );
      });
    } catch (error) {
      mapLastAdmin(error);
    }
  }
}
