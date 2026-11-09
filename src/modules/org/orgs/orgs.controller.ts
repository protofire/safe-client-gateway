import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { OrgSession, RequireStrongAuth } from '@/modules/org/auth/decorators';
import {
  OrgsService,
  type OrgListItem,
  type OrgView,
} from '@/modules/org/orgs/orgs.service';
import { actor, parse } from '@/modules/org/orgs/parse';
import type { Permission } from '@/modules/org/permissions/permissions';
import {
  AllowDeletedOrg,
  RequirePermission,
} from '@/modules/org/permissions/require-permission.decorator';

const NameSchema = z.object({ name: z.string().trim().min(1).max(64) });
const ListQuerySchema = z.object({
  includeDeleted: z.enum(['true', 'false']).optional(),
});

@Controller({ path: 'orgs', version: '1' })
export class OrgsController {
  constructor(private readonly orgs: OrgsService) {}

  @Post()
  create(
    @Req() req: Request,
    @OrgSession() session: OrgSession,
    @Body() body: unknown,
  ): Promise<OrgView> {
    const { name } = parse(NameSchema, body);
    return this.orgs.create(name, actor(req, session.userId));
  }

  @Get()
  list(
    @OrgSession() session: OrgSession,
    @Query() query: unknown,
  ): Promise<Array<OrgListItem>> {
    const { includeDeleted } = parse(ListQuerySchema, query);
    return this.orgs.list(session.userId, includeDeleted === 'true');
  }

  // deleted orgs: only for callers holding org.delete (OrgMemberGuard)
  @Get(':orgId')
  @AllowDeletedOrg()
  @RequirePermission('org.view')
  get(@Req() req: Request): Promise<OrgView> {
    return this.orgs.get(req.params.orgId);
  }

  @Get(':orgId/me')
  @RequirePermission('org.view')
  me(@Req() req: Request): {
    memberId: string;
    permissions: Array<Permission>;
  } {
    const { memberId, permissions } = req.orgMember!;
    return { memberId, permissions };
  }

  @Patch(':orgId')
  @RequirePermission('org.update')
  @RequireStrongAuth()
  rename(
    @Req() req: Request,
    @OrgSession() session: OrgSession,
    @Body() body: unknown,
  ): Promise<OrgView> {
    const { name } = parse(NameSchema, body);
    return this.orgs.rename(req.params.orgId, name, actor(req, session.userId));
  }

  @Delete(':orgId')
  @RequirePermission('org.delete')
  @RequireStrongAuth()
  delete(
    @Req() req: Request,
    @OrgSession() session: OrgSession,
  ): Promise<OrgView> {
    return this.orgs.delete(req.params.orgId, actor(req, session.userId));
  }

  @Post(':orgId/restore')
  @HttpCode(200)
  @AllowDeletedOrg()
  @RequirePermission('org.delete')
  @RequireStrongAuth()
  restore(
    @Req() req: Request,
    @OrgSession() session: OrgSession,
  ): Promise<OrgView> {
    return this.orgs.restore(req.params.orgId, actor(req, session.userId));
  }
}
