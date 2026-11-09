import { Module } from '@nestjs/common';
import { OrgMemberGuard } from '@/modules/org/permissions/org-member.guard';
import { PermissionResolver } from '@/modules/org/permissions/permission.resolver';

@Module({
  providers: [PermissionResolver, OrgMemberGuard],
  exports: [PermissionResolver, OrgMemberGuard],
})
export class PermissionsModule {}
