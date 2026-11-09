import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import type {
  EffectivePermissions,
  PermissionResolver,
} from '@/modules/org/permissions/permission.resolver';
import type { Permission } from '@/modules/org/permissions/permissions';

const DEADLOCK = '40P01';
const CHECK_VIOLATION = '23514';
const KEEP_ONE_ADMIN = 'members_keep_one_admin';

/**
 * Amendment A4: every path that can remove an admin locks the affected org
 * rows, ordered by id, before touching members. NO KEY UPDATE like the
 * last-admin trigger, so concurrent member inserts (KEY SHARE through the
 * foreign key) are not blocked. Returns the ids that still exist.
 */
export async function lockOrgs(
  em: EntityManager,
  orgIds: Array<string>,
): Promise<Array<string>> {
  if (orgIds.length === 0) return [];
  const rows: Array<{ id: string }> = await em.query(
    `SELECT id FROM organizations WHERE id = ANY($1::uuid[])
     ORDER BY id FOR NO KEY UPDATE`,
    [orgIds],
  );
  return rows.map((r) => r.id);
}

/**
 * After taking the org lock: the guard checked the permission before the
 * wait, a concurrent change may have revoked it since. Runs on the
 * transaction's `em` (no second pool connection while the lock is held).
 * 404 if the caller is no longer an active member of a live org (deleted
 * orgs only with `allowDeleted`), 403 if the permission is gone.
 */
export async function recheckPermission(
  resolver: PermissionResolver,
  em: Pick<EntityManager, 'query'>,
  orgId: string,
  userId: string,
  permission: Permission,
  opts: { allowDeleted?: boolean; deferForbidden?: boolean } = {},
): Promise<EffectivePermissions> {
  const effective = await resolver.effective(orgId, userId, em);
  if (!effective || (effective.orgStatus !== 'active' && !opts.allowDeleted)) {
    throw new NotFoundException();
  }
  if (!opts.deferForbidden && !effective.permissions.includes(permission)) {
    throw new ForbiddenException();
  }
  return effective;
}

export function lastAdminConflict(): ConflictException {
  return new ConflictException({
    statusCode: 409,
    message: 'An organization must keep at least one admin',
    code: 'last_admin',
  });
}

/** Maps the trigger's check_violation and lock deadlocks to 409 last_admin. */
export function mapLastAdmin(error: unknown): never {
  const e = error as {
    code?: string;
    constraint?: string;
    driverError?: { code?: string; constraint?: string };
  };
  const code = e.code ?? e.driverError?.code;
  const constraint = e.constraint ?? e.driverError?.constraint;
  if (
    code === DEADLOCK ||
    (code === CHECK_VIOLATION && constraint === KEEP_ONE_ADMIN)
  ) {
    throw lastAdminConflict();
  }
  throw error;
}

export function conflict(code: string, message: string): ConflictException {
  return new ConflictException({ statusCode: 409, message, code });
}
