import { ConflictException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

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
