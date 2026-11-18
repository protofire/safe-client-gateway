import { Module } from '@nestjs/common';
import { PermissionResolver } from '@/modules/org/permissions/permission.resolver';

/** `OrgMemberGuard` is registered globally (APP_GUARD) in OrgAppModule. */
@Module({
  providers: [PermissionResolver],
  exports: [PermissionResolver],
})
export class PermissionsModule {}
