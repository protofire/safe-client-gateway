import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { z } from 'zod';
import { PermissionResolver } from '@/modules/org/permissions/permission.resolver';
import type { Permission } from '@/modules/org/permissions/permissions';

export interface OrgMember {
  orgId: string;
  memberId: string;
  orgStatus: 'active' | 'deleted';
  permissions: Array<Permission>;
}

declare module 'express' {
  interface Request {
    orgMember?: OrgMember;
  }
}

export const REQUIRED_PERMISSION_KEY = 'org:requiredPermission';
export const ALLOW_DELETED_ORG_KEY = 'org:allowDeletedOrg';

const OrgIdSchema = z.uuid();

/**
 * Tenant boundary for `/v1/orgs/:orgId/**`: 404 unless the session user is an
 * active member of a live org (deleted allowed with `@AllowDeletedOrg()`), so
 * outsiders cannot probe which orgs exist; 403 only for members lacking the
 * permission. Attaches `req.orgMember`.
 */
@Injectable()
export class OrgMemberGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly resolver: PermissionResolver,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    // set by the session guard (Task 4)
    const userId = (req as { orgSession?: { userId: string } }).orgSession
      ?.userId;
    if (!userId) throw new UnauthorizedException();

    const orgId = OrgIdSchema.safeParse(req.params.orgId);
    if (!orgId.success) throw new NotFoundException();

    const targets = [context.getHandler(), context.getClass()];
    const effective = await this.resolver.effective(orgId.data, userId);
    if (
      !effective ||
      (effective.orgStatus === 'deleted' &&
        !this.reflector.getAllAndOverride<boolean>(
          ALLOW_DELETED_ORG_KEY,
          targets,
        ))
    ) {
      throw new NotFoundException();
    }

    const required = this.reflector.getAllAndOverride<Permission | undefined>(
      REQUIRED_PERMISSION_KEY,
      targets,
    );
    if (required && !effective.permissions.includes(required)) {
      throw new ForbiddenException();
    }

    req.orgMember = { orgId: orgId.data, ...effective };
    return true;
  }
}
