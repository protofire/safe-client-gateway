import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { z } from 'zod';
import { OrgSession } from '@/modules/org/auth/decorators';
import { MAX_CSV_BYTES } from '@/modules/org/common/csv';
import { actor, parse } from '@/modules/org/orgs/parse';
import { RequirePermission } from '@/modules/org/permissions/require-permission.decorator';
import { PayoutRunsService } from '@/modules/org/payouts/payout-runs.service';
import {
  CreatePayoutRunSchema,
  ImportPayoutRunSchema,
  ListPayoutRunsSchema,
  type PayoutRunDetail,
  type PayoutRunListItem,
  UpdatePayoutRunSchema,
} from '@/modules/org/payouts/payout.schemas';

function uuid(raw: string): string {
  if (!z.uuid().safeParse(raw).success) throw new NotFoundException();
  return raw;
}

/** Payout run drafts. Preparing a run has no on-chain effect: no step-up. */
@Controller({ path: 'orgs/:orgId', version: '1' })
export class PayoutRunsController {
  constructor(private readonly runs: PayoutRunsService) {}

  @Get('payout-runs')
  @RequirePermission('payouts.view')
  list(
    @Param('orgId') orgId: string,
    @Query() query: unknown,
  ): Promise<Array<PayoutRunListItem>> {
    const { linkedSafeId } = parse(ListPayoutRunsSchema, query);
    return this.runs.list(orgId, linkedSafeId);
  }

  @Post('payout-runs')
  @RequirePermission('payouts.prepare')
  create(
    @Req() req: Request,
    @Param('orgId') orgId: string,
    @OrgSession() session: OrgSession,
    @Body() body: unknown,
  ): Promise<PayoutRunDetail> {
    return this.runs.create(
      orgId,
      parse(CreatePayoutRunSchema, body),
      actor(req, session.userId),
    );
  }

  @Post('payout-runs/import')
  @RequirePermission('payouts.prepare')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_CSV_BYTES, files: 1 } }),
  )
  import(
    @Req() req: Request,
    @Param('orgId') orgId: string,
    @OrgSession() session: OrgSession,
    @Body() body: unknown,
    @UploadedFile() file: { buffer: Buffer } | undefined,
  ): Promise<PayoutRunDetail> {
    if (!file) throw new BadRequestException('Missing CSV file field "file"');
    return this.runs.import(
      orgId,
      {
        ...parse(ImportPayoutRunSchema, body),
        csv: file.buffer.toString('utf8'),
      },
      actor(req, session.userId),
    );
  }

  @Get('payout-runs/:runId')
  @RequirePermission('payouts.view')
  get(
    @Param('orgId') orgId: string,
    @Param('runId') runId: string,
    @OrgSession() session: OrgSession,
  ): Promise<PayoutRunDetail> {
    return this.runs.get(orgId, uuid(runId), session.userId);
  }

  @Patch('payout-runs/:runId')
  @RequirePermission('payouts.prepare')
  update(
    @Req() req: Request,
    @Param('orgId') orgId: string,
    @Param('runId') runId: string,
    @OrgSession() session: OrgSession,
    @Body() body: unknown,
  ): Promise<PayoutRunDetail> {
    return this.runs.update(
      orgId,
      uuid(runId),
      parse(UpdatePayoutRunSchema, body),
      actor(req, session.userId),
    );
  }

  @Delete('payout-runs/:runId')
  @HttpCode(204)
  @RequirePermission('payouts.prepare')
  remove(
    @Req() req: Request,
    @Param('orgId') orgId: string,
    @Param('runId') runId: string,
    @OrgSession() session: OrgSession,
  ): Promise<void> {
    return this.runs.remove(orgId, uuid(runId), actor(req, session.userId));
  }

  @Post('payout-runs/:runId/build')
  @HttpCode(200)
  @RequirePermission('payouts.prepare')
  build(
    @Param('orgId') orgId: string,
    @Param('runId') runId: string,
    @OrgSession() session: OrgSession,
  ): Promise<PayoutRunDetail> {
    return this.runs.build(orgId, uuid(runId), session.userId);
  }
}
