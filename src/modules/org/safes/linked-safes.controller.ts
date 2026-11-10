import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { isAddress } from 'viem';
import { z } from 'zod';
import { OrgSession, RequireStrongAuth } from '@/modules/org/auth/decorators';
import { RateLimiter } from '@/modules/org/common/rate-limiter';
import { actor, parse } from '@/modules/org/orgs/parse';
import { RequirePermission } from '@/modules/org/permissions/require-permission.decorator';
import {
  LinkedSafesService,
  type LinkedSafeRow,
  type LinkedSafeView,
} from '@/modules/org/safes/linked-safes.service';
import {
  OverviewService,
  type Overview,
} from '@/modules/org/safes/overview.service';
import {
  OrgApiBody,
  OrgApiQuery,
} from '@/modules/org/common/org-api-body.decorator';

const LinkSchema = z.object({
  chainId: z.string().regex(/^[1-9]\d{0,19}$/),
  address: z.string().refine((v) => isAddress(v, { strict: false })),
  label: z.string().trim().min(1).max(64).optional(),
});
// each overview fans out to the tx-service for up to 50 Safes (item 7)
const OVERVIEWS_PER_USER_PER_MINUTE = 30;
const OverviewQuerySchema = z.object({
  fiat: z
    .string()
    .regex(/^[a-zA-Z]{2,5}$/)
    .default('USD'),
});

@Controller({ path: 'orgs/:orgId', version: '1' })
export class LinkedSafesController {
  constructor(
    private readonly linked: LinkedSafesService,
    private readonly overview: OverviewService,
    private readonly rateLimiter: RateLimiter,
  ) {}

  @Post('safes')
  @OrgApiBody(LinkSchema)
  @RequirePermission('safes.link')
  @RequireStrongAuth()
  link(
    @Req() req: Request,
    @OrgSession() session: OrgSession,
    @Body() body: unknown,
  ): Promise<LinkedSafeRow> {
    const input = parse(LinkSchema, body);
    return this.linked.link(
      req.params.orgId,
      input,
      actor(req, session.userId),
    );
  }

  @Delete('safes/:linkedSafeId')
  @HttpCode(204)
  @RequirePermission('safes.unlink')
  @RequireStrongAuth()
  async unlink(
    @Req() req: Request,
    @OrgSession() session: OrgSession,
    @Param('linkedSafeId') linkedSafeId: string,
  ): Promise<void> {
    // a malformed id cannot belong to any org
    if (!z.uuid().safeParse(linkedSafeId).success)
      throw new NotFoundException();
    await this.linked.unlink(
      req.params.orgId,
      linkedSafeId,
      actor(req, session.userId),
    );
  }

  @Get('safes')
  @RequirePermission('safes.view')
  list(
    @Req() req: Request,
    @OrgSession() session: OrgSession,
  ): Promise<Array<LinkedSafeView>> {
    return this.linked.list(req.params.orgId, session.userId);
  }

  @Get('overview')
  @OrgApiQuery(OverviewQuerySchema)
  @RequirePermission('safes.view')
  async getOverview(
    @Req() req: Request,
    @OrgSession() session: OrgSession,
    @Query() query: unknown,
  ): Promise<Overview> {
    const { fiat } = parse(OverviewQuerySchema, query);
    await this.rateLimiter.enforce(
      `overview:user:${session.userId}`,
      OVERVIEWS_PER_USER_PER_MINUTE,
      60,
    );
    return this.overview.build(req.params.orgId, session.userId, fiat);
  }
}
