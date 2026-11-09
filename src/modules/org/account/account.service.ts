import { Inject, Injectable } from '@nestjs/common';
import { ActivityLog } from '@/modules/org/activity/activity-log.service';
import { Clock, type IClock } from '@/modules/org/common/clock';
import { OrgTransaction } from '@/modules/org/db/org-transaction';
import { lockOrgs, mapLastAdmin } from '@/modules/org/orgs/org-lock';

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
  ) {}

  async delete(userId: string): Promise<void> {
    const now = this.clock.now();
    try {
      await this.tx.runInOrgTx(async (em) => {
        // A4: every org the user has a row in, locked in id order, before
        // the membership deletes the last-admin trigger checks at commit
        const memberships: Array<{ orgId: string; status: string }> =
          await em.query(
            `SELECT org_id AS "orgId", status FROM members WHERE user_id = $1`,
            [userId],
          );
        await lockOrgs(
          em,
          memberships.map((m) => m.orgId),
        );
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
