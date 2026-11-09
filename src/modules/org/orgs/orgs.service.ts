import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { ActivityLog } from '@/modules/org/activity/activity-log.service';
import { Clock, type IClock } from '@/modules/org/common/clock';
import { OrgTransaction } from '@/modules/org/db/org-transaction';
import {
  conflict,
  lockOrgs,
  mapLastAdmin,
  recheckPermission,
} from '@/modules/org/orgs/org-lock';
import type { Actor } from '@/modules/org/orgs/parse';
import { PermissionResolver } from '@/modules/org/permissions/permission.resolver';
import { PERMISSIONS } from '@/modules/org/permissions/permissions';

export const MAX_ORGS_PER_USER = 10;
export const PURGE_AFTER_DAYS = 30;
const DAY_MS = 24 * 3600 * 1000;

export type OrgListItem = {
  id: string;
  name: string;
  status: 'active' | 'deleted';
  myStatus: 'active' | 'invited';
  purgeAfter?: string;
};

export type OrgView = {
  id: string;
  name: string;
  status: 'active' | 'deleted';
  createdAt: string;
  purgeAfter: string | null;
};

/**
 * Locks the user row (NO KEY UPDATE: member inserts referencing it still
 * proceed) and checks the orgs-per-user limit (spec §8) under that lock.
 */
export async function assertOrgLimit(
  em: EntityManager,
  userId: string,
): Promise<void> {
  await em.query(`SELECT 1 FROM users WHERE id = $1 FOR NO KEY UPDATE`, [
    userId,
  ]);
  const [{ count }]: Array<{ count: number }> = await em.query(
    `SELECT count(*)::int AS count FROM members m
     JOIN organizations o ON o.id = m.org_id
     WHERE m.user_id = $1 AND m.status = 'active' AND o.status = 'active'`,
    [userId],
  );
  if (count >= MAX_ORGS_PER_USER) {
    throw conflict(
      'org_limit',
      `A user can belong to at most ${MAX_ORGS_PER_USER} organizations`,
    );
  }
}

@Injectable()
export class OrgsService {
  constructor(
    private readonly tx: OrgTransaction,
    private readonly activity: ActivityLog,
    private readonly resolver: PermissionResolver,
    @Inject(Clock) private readonly clock: IClock,
  ) {}

  async create(name: string, by: Actor): Promise<OrgView> {
    return this.tx.runInOrgTx(async (em) => {
      await assertOrgLimit(em, by.userId);
      const [org]: Array<OrgView> = await em.query(
        `INSERT INTO organizations (name) VALUES ($1)
         RETURNING id, name, status, created_at AS "createdAt", purge_after AS "purgeAfter"`,
        [name],
      );
      const [{ id: memberId }] = await em.query(
        `INSERT INTO members (org_id, user_id, status) VALUES ($1, $2, 'active') RETURNING id`,
        [org.id, by.userId],
      );
      // the creator gets the system role that grants every permission
      // (permissions as data: no role key in code)
      const [role]: Array<{ id: string }> = await em.query(
        `SELECT id FROM roles WHERE org_id IS NULL AND permissions @> $1::text[]
         ORDER BY version DESC, id LIMIT 1`,
        [[...PERMISSIONS]],
      );
      await em.query(
        `INSERT INTO role_bindings (member_id, role_id) VALUES ($1, $2)`,
        [memberId, role.id],
      );
      await this.activity.record(em, {
        orgId: org.id,
        actorUserId: by.userId,
        type: 'org.created',
        payload: { name },
        ip: by.ip,
        userAgent: by.userAgent,
      });
      return serialize(org);
    });
  }

  /**
   * Orgs where the caller is active, plus pending wallet invitations to one
   * of their wallets. With
   * `includeDeleted`, also deleted orgs where they hold `org.delete`.
   */
  async list(userId: string, includeDeleted: boolean): Promise<Array<OrgListItem>> {
    const rows: Array<{
      id: string;
      name: string;
      status: 'active' | 'deleted';
      myStatus: 'active' | 'invited';
      purgeAfter: Date | null;
    }> = await this.tx.runInOrgTx((em) =>
      em.query(
        `SELECT o.id, o.name, o.status, 'active' AS "myStatus", o.purge_after AS "purgeAfter"
         FROM members m JOIN organizations o ON o.id = m.org_id
         WHERE m.user_id = $1 AND m.status = 'active'
           AND (o.status = 'active' OR ($2 AND EXISTS (
             SELECT 1 FROM role_bindings rb JOIN roles r ON r.id = rb.role_id
             WHERE rb.member_id = m.id AND rb.scope = 'org'
               AND (r.org_id IS NULL OR r.org_id = m.org_id)
               AND 'org.delete' = ANY(r.permissions))))
         UNION
         SELECT o.id, o.name, o.status, 'invited', NULL
         FROM invitations i
         JOIN members m ON m.id = i.member_id AND m.status = 'invited'
         JOIN organizations o ON o.id = i.org_id AND o.status = 'active'
         WHERE i.accepted_at IS NULL AND i.declined_at IS NULL AND i.expires_at > $3
           -- only wallet invitations, the ones answerable by org id (A9);
           -- email invitations are answered with the mailed token
           AND i.target_wallet IN (SELECT wallet_address FROM identities WHERE user_id = $1 AND kind = 'wallet')
           AND NOT EXISTS (SELECT 1 FROM members x WHERE x.org_id = o.id AND x.user_id = $1 AND x.status = 'active')
         ORDER BY name, id`,
        [userId, includeDeleted, this.clock.now()],
      ),
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      myStatus: r.myStatus,
      ...(r.status === 'deleted' && r.purgeAfter
        ? { purgeAfter: new Date(r.purgeAfter).toISOString() }
        : {}),
    }));
  }

  async get(orgId: string): Promise<OrgView> {
    const [org]: Array<OrgView> = await this.tx.runInOrgTx((em) =>
      em.query(
        `SELECT id, name, status, created_at AS "createdAt", purge_after AS "purgeAfter"
         FROM organizations WHERE id = $1`,
        [orgId],
      ),
    );
    if (!org) throw new NotFoundException();
    return serialize(org);
  }

  async rename(orgId: string, name: string, by: Actor): Promise<OrgView> {
    return this.tx.runInOrgTx(async (em) => {
      await lockOrgs(em, [orgId]);
      await recheckPermission(this.resolver, em, orgId, by.userId, 'org.update');
      const [before]: Array<{ name: string }> = await em.query(
        `SELECT name FROM organizations WHERE id = $1 AND status = 'active'`,
        [orgId],
      );
      if (!before) throw new NotFoundException();
      // UPDATE … RETURNING resolves to [rows, affected] in TypeORM's postgres driver
      const [[org]]: [Array<OrgView>, number] = await em.query(
        `UPDATE organizations SET name = $2, updated_at = $3 WHERE id = $1
         RETURNING id, name, status, created_at AS "createdAt", purge_after AS "purgeAfter"`,
        [orgId, name, this.clock.now()],
      );
      if (before.name !== name) {
        await this.activity.record(em, {
          orgId,
          actorUserId: by.userId,
          type: 'org.renamed',
          payload: { from: before.name, to: name },
          ip: by.ip,
          userAgent: by.userAgent,
        });
      }
      return serialize(org);
    });
  }

  /** Soft delete: hidden from members, restorable until `purge_after`. */
  async delete(orgId: string, by: Actor): Promise<OrgView> {
    const now = this.clock.now();
    return this.tx.runInOrgTx(async (em) => {
      await lockOrgs(em, [orgId]);
      await recheckPermission(this.resolver, em, orgId, by.userId, 'org.delete');
      const [[org]]: [Array<OrgView>, number] = await em.query(
        `UPDATE organizations
         SET status = 'deleted', deleted_at = $2, purge_after = $3, updated_at = $2
         WHERE id = $1 AND status = 'active'
         RETURNING id, name, status, created_at AS "createdAt", purge_after AS "purgeAfter"`,
        [orgId, now, new Date(now.getTime() + PURGE_AFTER_DAYS * DAY_MS)],
      );
      if (!org) throw new NotFoundException();
      await this.activity.record(em, {
        orgId,
        actorUserId: by.userId,
        type: 'org.deleted',
        ip: by.ip,
        userAgent: by.userAgent,
      });
      return serialize(org);
    });
  }

  /**
   * Amendment A10: locks the row (a running purge holds it FOR UPDATE, so
   * this waits and then finds it gone) and restores only before `purge_after`.
   */
  async restore(orgId: string, by: Actor): Promise<OrgView> {
    const now = this.clock.now();
    try {
      return await this.tx.runInOrgTx(async (em) => {
        const [locked]: Array<{ status: string; purgeAfter: Date | null }> =
          await em.query(
            `SELECT status, purge_after AS "purgeAfter" FROM organizations
             WHERE id = $1 FOR UPDATE`,
            [orgId],
          );
        if (
          !locked ||
          locked.status !== 'deleted' ||
          !locked.purgeAfter ||
          new Date(locked.purgeAfter) <= now
        ) {
          throw new NotFoundException();
        }
        await recheckPermission(this.resolver, em, orgId, by.userId, 'org.delete', {
          allowDeleted: true,
        });
        // the restored org counts again towards the admin's org limit
        await assertOrgLimit(em, by.userId);
        const [[org]]: [Array<OrgView>, number] = await em.query(
          `UPDATE organizations
           SET status = 'active', deleted_at = NULL, purge_after = NULL, updated_at = $2
           WHERE id = $1
           RETURNING id, name, status, created_at AS "createdAt", purge_after AS "purgeAfter"`,
          [orgId, now],
        );
        await this.activity.record(em, {
          orgId,
          actorUserId: by.userId,
          type: 'org.restored',
          ip: by.ip,
          userAgent: by.userAgent,
        });
        return serialize(org);
      });
    } catch (error) {
      // restoring an org whose admins all left meanwhile: the trigger refuses
      return mapLastAdmin(error);
    }
  }
}

function serialize(org: OrgView): OrgView {
  return {
    id: org.id,
    name: org.name,
    status: org.status,
    createdAt: new Date(org.createdAt).toISOString(),
    purgeAfter: org.purgeAfter ? new Date(org.purgeAfter).toISOString() : null,
  };
}
