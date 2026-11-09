import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ActivityLog } from '@/modules/org/activity/activity-log.service';
import type { OrgSession } from '@/modules/org/auth/decorators';
import { SecurityEvents } from '@/modules/org/auth/security-events';
import { SessionsRepository } from '@/modules/org/auth/sessions.repository';
import { Clock, type IClock } from '@/modules/org/common/clock';
import { OrgTransaction } from '@/modules/org/db/org-transaction';
import { conflict, lockOrgs, mapLastAdmin } from '@/modules/org/orgs/org-lock';

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

  async delete(userId: string): Promise<void> {
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
          `UPDATE users SET status = 'deleted', deleted_at = $2, updated_at = $2
           WHERE id = $1 AND status = 'active' RETURNING id`,
          [userId, now],
        );
        if (!user) return;
        for (const { orgId } of memberships.filter(
          (m) => m.status === 'active',
        )) {
          await this.activity.record(em, {
            orgId,
            actorUserId: userId,
            type: 'member.left',
            payload: { target: 'Deleted user', reason: 'account_deleted' },
          });
        }
        await em.query(`DELETE FROM members WHERE user_id = $1`, [userId]);
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
