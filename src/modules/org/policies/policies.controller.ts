import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { OrgSession, RequireStrongAuth } from '@/modules/org/auth/decorators';
import { actor, parse } from '@/modules/org/orgs/parse';
import { RequirePermission } from '@/modules/org/permissions/require-permission.decorator';
import { PoliciesService } from '@/modules/org/policies/policies.service';
import {
  CreatePolicySchema,
  type Policy,
  UpdatePolicySchema,
} from '@/modules/org/policies/policies.schemas';

function uuid(raw: string): string {
  if (!z.uuid().safeParse(raw).success) throw new NotFoundException();
  return raw;
}

/** Org policies: warnings only, checked inside the app. */
@Controller({ path: 'orgs/:orgId', version: '1' })
export class PoliciesController {
  constructor(private readonly policies: PoliciesService) {}

  @Get('policies')
  @RequirePermission('policies.view')
  list(@Param('orgId') orgId: string): Promise<Array<Policy>> {
    return this.policies.list(orgId);
  }

  @Post('policies')
  @RequirePermission('policies.write')
  @RequireStrongAuth()
  create(
    @Req() req: Request,
    @Param('orgId') orgId: string,
    @OrgSession() session: OrgSession,
    @Body() body: unknown,
  ): Promise<Policy> {
    return this.policies.create(
      orgId,
      parse(CreatePolicySchema, body),
      actor(req, session.userId),
    );
  }

  @Put('policies/:policyId')
  @RequirePermission('policies.write')
  @RequireStrongAuth()
  update(
    @Req() req: Request,
    @Param('orgId') orgId: string,
    @Param('policyId') policyId: string,
    @OrgSession() session: OrgSession,
    @Body() body: unknown,
  ): Promise<Policy> {
    return this.policies.update(
      orgId,
      uuid(policyId),
      parse(UpdatePolicySchema, body),
      actor(req, session.userId),
    );
  }

  @Delete('policies/:policyId')
  @HttpCode(204)
  @RequirePermission('policies.write')
  @RequireStrongAuth()
  remove(
    @Req() req: Request,
    @Param('orgId') orgId: string,
    @Param('policyId') policyId: string,
    @OrgSession() session: OrgSession,
  ): Promise<void> {
    return this.policies.remove(
      orgId,
      uuid(policyId),
      actor(req, session.userId),
    );
  }
}
