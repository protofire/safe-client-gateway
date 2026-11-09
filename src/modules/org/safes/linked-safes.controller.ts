import {
  BadRequestException,
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

const LinkSchema = z.object({
  chainId: z.string().regex(/^\d{1,20}$/),
  address: z.string().refine((v) => isAddress(v, { strict: false })),
  label: z.string().trim().min(1).max(64).optional(),
});
const OverviewQuerySchema = z.object({
  fiat: z
    .string()
    .regex(/^[a-zA-Z]{2,5}$/)
    .default('USD'),
});

// ZodErrorFilter answers 502 (gateway upstream semantics); bad input is a 400
function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new BadRequestException(parsed.error.message);
  return parsed.data;
}

@Controller({ path: 'orgs/:orgId', version: '1' })
export class LinkedSafesController {
  constructor(
    private readonly linked: LinkedSafesService,
    private readonly overview: OverviewService,
  ) {}

  @Post('safes')
  @RequirePermission('safes.link')
  @RequireStrongAuth()
  link(
    @Req() req: Request,
    @OrgSession() session: OrgSession,
    @Body() body: unknown,
  ): Promise<LinkedSafeRow> {
    const input = parse(LinkSchema, body);
    return this.linked.link(req.params.orgId, input, {
      userId: session.userId,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
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
    await this.linked.unlink(req.params.orgId, linkedSafeId, {
      userId: session.userId,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
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
  @RequirePermission('safes.view')
  getOverview(
    @Req() req: Request,
    @OrgSession() session: OrgSession,
    @Query() query: unknown,
  ): Promise<Overview> {
    const { fiat } = parse(OverviewQuerySchema, query);
    return this.overview.build(req.params.orgId, session.userId, fiat);
  }
}
