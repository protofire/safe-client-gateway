import { applyDecorators, SetMetadata, UseGuards } from '@nestjs/common';
import {
  ALLOW_DELETED_ORG_KEY,
  OrgMemberGuard,
  REQUIRED_PERMISSION_KEY,
} from '@/modules/org/permissions/org-member.guard';
import type { Permission } from '@/modules/org/permissions/permissions';

/**
 * Route under `:orgId`: the caller must be an active member holding `permission`.
 * Applies `OrgMemberGuard`, which must run after the session guard.
 */
export function RequirePermission(
  permission: Permission,
): MethodDecorator & ClassDecorator {
  return applyDecorators(
    SetMetadata(REQUIRED_PERMISSION_KEY, permission),
    UseGuards(OrgMemberGuard),
  );
}

/** Lets `OrgMemberGuard` admit a deleted org (restore, admin view). */
export const AllowDeletedOrg = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ALLOW_DELETED_ORG_KEY, true);
