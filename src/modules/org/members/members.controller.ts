import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { isAddress } from 'viem';
import { z } from 'zod';
import { OrgSession, RequireStrongAuth } from '@/modules/org/auth/decorators';
import { InvitationsService } from '@/modules/org/members/invitations.service';
import {
  MembersService,
  type MemberView,
} from '@/modules/org/members/members.service';
import { actor, parse } from '@/modules/org/orgs/parse';
import { RequirePermission } from '@/modules/org/permissions/require-permission.decorator';
import {
  INVITATION_ROLE_KEY,
  SYSTEM_ROLE_KEYS,
} from '@/modules/org/permissions/role-keys';
import { OrgApiBody } from '@/modules/org/common/org-api-body.decorator';

const InviteSchema = z
  .object({
    wallet: z
      .string()
      .refine((v) => isAddress(v, { strict: false }))
      .optional(),
    email: z.email().max(254).optional(),
    // accepted for compatibility; any other role is a 400 (item 1)
    role: z.literal(INVITATION_ROLE_KEY).optional(),
  })
  .refine((v) => (v.wallet === undefined) !== (v.email === undefined), {
    error: 'Exactly one of wallet or email',
  });
const RoleSchema = z.object({ role: z.enum(SYSTEM_ROLE_KEYS) });

function memberUuid(value: string): string {
  if (!z.uuid().safeParse(value).success) throw new NotFoundException();
  return value;
}

@Controller({ path: 'orgs/:orgId/members', version: '1' })
export class MembersController {
  constructor(
    private readonly members: MembersService,
    private readonly invitations: InvitationsService,
  ) {}

  @Get()
  @RequirePermission('members.view')
  list(
    @Req() req: Request,
    @OrgSession() session: OrgSession,
  ): Promise<Array<MemberView>> {
    return this.members.list(req.params.orgId, {
      userId: session.userId,
      permissions: req.orgMember!.permissions,
    });
  }

  @Post('invite')
  @OrgApiBody(InviteSchema)
  @RequirePermission('members.invite')
  @RequireStrongAuth()
  invite(
    @Req() req: Request,
    @OrgSession() session: OrgSession,
    @Body() body: unknown,
  ): Promise<MemberView & { emailSent?: boolean }> {
    const input = parse(InviteSchema, body);
    return this.invitations.invite(
      req.params.orgId,
      input.wallet !== undefined
        ? { wallet: input.wallet }
        : { email: input.email! },
      actor(req, session.userId),
    );
  }

  @Post('leave')
  @HttpCode(204)
  @RequirePermission('org.view')
  async leave(
    @Req() req: Request,
    @OrgSession() session: OrgSession,
  ): Promise<void> {
    await this.members.leave(req.params.orgId, actor(req, session.userId));
  }

  @Post(':memberId/invite/renew')
  @HttpCode(200)
  @RequirePermission('members.invite')
  @RequireStrongAuth()
  renew(
    @Req() req: Request,
    @OrgSession() session: OrgSession,
    @Param('memberId') memberId: string,
  ): Promise<{ expiresAt: string; emailSent?: boolean }> {
    return this.invitations.renew(
      req.params.orgId,
      memberUuid(memberId),
      actor(req, session.userId),
    );
  }

  @Patch(':memberId/role')
  @OrgApiBody(RoleSchema)
  @HttpCode(204)
  @RequirePermission('roles.assign')
  @RequireStrongAuth()
  async changeRole(
    @Req() req: Request,
    @OrgSession() session: OrgSession,
    @Param('memberId') memberId: string,
    @Body() body: unknown,
  ): Promise<void> {
    const { role } = parse(RoleSchema, body);
    await this.members.changeRole(
      req.params.orgId,
      memberUuid(memberId),
      role,
      actor(req, session.userId),
    );
  }

  @Delete(':memberId')
  @HttpCode(204)
  @RequirePermission('members.remove')
  @RequireStrongAuth()
  async remove(
    @Req() req: Request,
    @OrgSession() session: OrgSession,
    @Param('memberId') memberId: string,
  ): Promise<void> {
    await this.members.remove(
      req.params.orgId,
      memberUuid(memberId),
      actor(req, session.userId),
    );
  }

  @Post(':memberId/factors/reset')
  @HttpCode(204)
  @RequirePermission('factors.reset')
  @RequireStrongAuth()
  async resetFactors(
    @Req() req: Request,
    @OrgSession() session: OrgSession,
    @Param('memberId') memberId: string,
  ): Promise<void> {
    await this.members.resetFactors(req.params.orgId, memberUuid(memberId), {
      ...actor(req, session.userId),
      sessionId: session.sessionId,
    });
  }
}
