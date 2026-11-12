import {
  Body,
  Controller,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { OrgSession } from '@/modules/org/auth/decorators';
import { InvitationsService } from '@/modules/org/members/invitations.service';
import { actor, parse } from '@/modules/org/orgs/parse';
import { OrgApiBody } from '@/modules/org/common/org-api-body.decorator';

const TokenSchema = z.object({ token: z.string().min(16).max(128) });

/**
 * Answering an invitation: the caller is not a member yet, so these routes
 * deliberately have no `:orgId` param (OrgMemberGuard would answer 404).
 * The service checks the caller's identity against the invitation target.
 * Registered before any `/v1/orgs/:orgId` controller (route order).
 */
@Controller({ path: 'orgs', version: '1' })
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @Post('invitations/accept')
  @OrgApiBody(TokenSchema)
  @HttpCode(200)
  accept(
    @Req() req: Request,
    @OrgSession() session: OrgSession,
    @Body() body: unknown,
  ): Promise<{ orgId: string }> {
    const { token } = parse(TokenSchema, body);
    return this.invitations.acceptByToken(token, actor(req, session.userId));
  }

  @Post('invitations/decline')
  @OrgApiBody(TokenSchema)
  @HttpCode(200)
  decline(
    @Req() req: Request,
    @OrgSession() session: OrgSession,
    @Body() body: unknown,
  ): Promise<{ orgId: string }> {
    const { token } = parse(TokenSchema, body);
    return this.invitations.declineByToken(token, actor(req, session.userId));
  }

  @Post(':invitedOrgId/members/accept')
  @HttpCode(200)
  acceptById(
    @Req() req: Request,
    @OrgSession() session: OrgSession,
    @Param('invitedOrgId') orgId: string,
  ): Promise<{ orgId: string }> {
    return this.invitations.acceptById(
      orgUuid(orgId),
      actor(req, session.userId),
    );
  }

  @Post(':invitedOrgId/members/decline')
  @HttpCode(200)
  declineById(
    @Req() req: Request,
    @OrgSession() session: OrgSession,
    @Param('invitedOrgId') orgId: string,
  ): Promise<{ orgId: string }> {
    return this.invitations.declineById(
      orgUuid(orgId),
      actor(req, session.userId),
    );
  }
}

function orgUuid(value: string): string {
  if (!z.uuid().safeParse(value).success) throw new NotFoundException();
  return value;
}
