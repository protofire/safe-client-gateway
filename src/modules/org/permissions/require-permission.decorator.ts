import { SetMetadata } from '@nestjs/common';
import {
  ALLOW_DELETED_ORG_KEY,
  REQUIRED_PERMISSION_KEY,
} from '@/modules/org/permissions/org-member.guard';
import type { Permission } from '@/modules/org/permissions/permissions';

/**
 * Required on every route with `:orgId`: the caller must be an active member
 * holding `permission`. Enforced by the global `OrgMemberGuard`.
 */
export const RequirePermission = (
  permission: Permission,
): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_PERMISSION_KEY, permission);

/**
 * Lets `OrgMemberGuard` admit a deleted org (restore, admin view); the caller
 * then also needs `org.delete`.
 */
export const AllowDeletedOrg = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ALLOW_DELETED_ORG_KEY, true);
