import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { z } from 'zod';
import {
  type ILoggingService,
  LoggingService,
} from '@/logging/logging.interface';
import {
  type EffectivePermissions,
  PermissionResolver,
} from '@/modules/org/permissions/permission.resolver';
import type { Permission } from '@/modules/org/permissions/permissions';

export type OrgMember = EffectivePermissions & { orgId: string };

declare module 'express' {
  interface Request {
    orgMember?: OrgMember;
  }
}

export const REQUIRED_PERMISSION_KEY = 'org:requiredPermission';
export const ALLOW_DELETED_ORG_KEY = 'org:allowDeletedOrg';
const DELETED_ORG_PERMISSION: Permission = 'org.delete';

const OrgIdSchema = z.uuid();

/**
 * Global tenant boundary (APP_GUARD, after the session guard). Routes without
 * `:orgId` pass through. Routes with `:orgId` fail closed: no
 * `@RequirePermission()` → 403; not an active member of a live org → 404 (so
 * outsiders cannot probe which orgs exist); deleted org → 404 unless the route
 * has `@AllowDeletedOrg()` and the caller holds `org.delete`; missing
 * permission → 403. Attaches `req.orgMember`.
 */
@Injectable()
export class OrgMemberGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly resolver: PermissionResolver,
    @Inject(LoggingService) private readonly logger: ILoggingService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    if (!('orgId' in req.params)) return true;

    const targets = [context.getHandler(), context.getClass()];
    const required = this.reflector.getAllAndOverride<Permission | undefined>(
      REQUIRED_PERMISSION_KEY,
      targets,
    );
    if (!required) {
      this.logger.error(
        `OrgMemberGuard: ${context.getClass().name}.${context.getHandler().name} has :orgId but no @RequirePermission(); denied`,
      );
      throw new ForbiddenException();
    }

    // set by the session guard (Task 4)
    const userId = (req as { orgSession?: { userId: string } }).orgSession
      ?.userId;
    if (!userId) throw new UnauthorizedException();

    const orgId = OrgIdSchema.safeParse(req.params.orgId);
    if (!orgId.success) throw new NotFoundException();

    const effective = await this.resolver.effective(orgId.data, userId);
    if (!effective) throw new NotFoundException();
    if (
      effective.orgStatus === 'deleted' &&
      !(
        this.reflector.getAllAndOverride<boolean>(
          ALLOW_DELETED_ORG_KEY,
          targets,
        ) && effective.permissions.includes(DELETED_ORG_PERMISSION)
      )
    ) {
      throw new NotFoundException();
    }
    if (!effective.permissions.includes(required)) {
      throw new ForbiddenException();
    }

    req.orgMember = { orgId: orgId.data, ...effective };
    return true;
  }
}
