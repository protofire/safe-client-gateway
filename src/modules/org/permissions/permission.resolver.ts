import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager } from 'typeorm';
import { ORG_DATA_SOURCE } from '@/modules/org/db/org-data-source';
import {
  PERMISSIONS,
  type Permission,
} from '@/modules/org/permissions/permissions';

export interface EffectivePermissions {
  memberId: string;
  orgStatus: 'active' | 'deleted';
  permissions: Array<Permission>;
}

@Injectable()
export class PermissionResolver {
  constructor(
    @InjectDataSource(ORG_DATA_SOURCE) private readonly dataSource: DataSource,
  ) {}

  /**
   * Union of the permissions of the user's org-scoped roles, or null unless
   * an active user is an active member. Deleted orgs resolve too (see `orgStatus`).
   * Pass the transaction's `em` when re-checking under a lock, so no second
   * pool connection is needed while the lock is held.
   */
  async effective(
    orgId: string,
    userId: string,
    em: Pick<EntityManager, 'query'> = this.dataSource,
  ): Promise<EffectivePermissions | null> {
    const rows: Array<{
      member_id: string;
      org_status: 'active' | 'deleted';
      permissions: Array<string> | null;
    }> = await em.query(
      `SELECT m.id AS member_id, o.status AS org_status, r.permissions
       FROM members m
       JOIN organizations o ON o.id = m.org_id
       JOIN users u ON u.id = m.user_id AND u.status = 'active'
       LEFT JOIN role_bindings rb ON rb.member_id = m.id AND rb.scope = 'org'
       -- system roles, or custom roles of this org only
       LEFT JOIN roles r ON r.id = rb.role_id
         AND (r.org_id IS NULL OR r.org_id = m.org_id)
       WHERE m.org_id = $1 AND m.user_id = $2 AND m.status = 'active'`,
      [orgId, userId],
    );
    if (rows.length === 0) return null;
    const granted = new Set(rows.flatMap((row) => row.permissions ?? []));
    return {
      memberId: rows[0].member_id,
      orgStatus: rows[0].org_status,
      // unknown keys (granted by a newer migration) are dropped
      permissions: PERMISSIONS.filter((p) => granted.has(p)),
    };
  }
}
