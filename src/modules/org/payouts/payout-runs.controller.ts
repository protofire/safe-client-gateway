import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { Readable } from 'stream';
import { z } from 'zod';
import { ILoggingService, LoggingService } from '@/logging/logging.interface';
import { CsvService } from '@/modules/csv-export/csv-utils/csv.service';
import { OrgSession } from '@/modules/org/auth/decorators';
import {
  CSV_UPLOAD_LIMITS,
  csvCast,
  limitExports,
} from '@/modules/org/common/csv';
import { RateLimiter } from '@/modules/org/common/rate-limiter';
import { actor, parse } from '@/modules/org/orgs/parse';
import { RequirePermission } from '@/modules/org/permissions/require-permission.decorator';
import {
  ClaimProposalSchema,
  PayoutProposalsService,
  ReportProposalSchema,
  type ClaimResult,
} from '@/modules/org/payouts/payout-proposals.service';
import { PayoutRunsService } from '@/modules/org/payouts/payout-runs.service';
import {
  BuildPayoutRunSchema,
  CreatePayoutRunDocSchema,
  CreatePayoutRunSchema,
  ImportPayoutRunSchema,
  ListPayoutRunsSchema,
  ResolvePayoutRunSchema,
  type PayoutRunDetail,
  type PayoutRunPage,
  UpdatePayoutRunDocSchema,
  UpdatePayoutRunSchema,
} from '@/modules/org/payouts/payout.schemas';
import {
  OrgApiBody,
  OrgApiFile,
  OrgApiQuery,
} from '@/modules/org/common/org-api-body.decorator';

function uuid(raw: string): string {
  if (!z.uuid().safeParse(raw).success) throw new NotFoundException();
  return raw;
}

/** Payout run drafts. Preparing a run has no on-chain effect: no step-up. */
@Controller({ path: 'orgs/:orgId', version: '1' })
export class PayoutRunsController {
  constructor(
    private readonly runs: PayoutRunsService,
    private readonly proposals: PayoutProposalsService,
    private readonly csv: CsvService,
    private readonly rateLimiter: RateLimiter,
    @Inject(LoggingService) private readonly logger: ILoggingService,
  ) {}

  @Get('payout-runs')
  @OrgApiQuery(ListPayoutRunsSchema)
  @RequirePermission('payouts.view')
  list(
    @Param('orgId') orgId: string,
    @Query() query: unknown,
  ): Promise<PayoutRunPage> {
    return this.runs.list(orgId, parse(ListPayoutRunsSchema, query));
  }

  @Post('payout-runs')
  @OrgApiBody(CreatePayoutRunDocSchema)
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
  @OrgApiFile(ImportPayoutRunSchema)
  @RequirePermission('payouts.prepare')
  @UseInterceptors(FileInterceptor('file', { limits: CSV_UPLOAD_LIMITS }))
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
  @OrgApiBody(UpdatePayoutRunDocSchema)
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
  @OrgApiBody(BuildPayoutRunSchema)
  @HttpCode(200)
  @RequirePermission('payouts.prepare')
  build(
    @Req() req: Request,
    @Param('orgId') orgId: string,
    @Param('runId') runId: string,
    @OrgSession() session: OrgSession,
    @Body() body: unknown,
  ): Promise<PayoutRunDetail> {
    return this.runs.build(
      orgId,
      uuid(runId),
      parse(BuildPayoutRunSchema, body).expectedVersion,
      actor(req, session.userId),
    );
  }

  /** Claim before the signing flow opens; the UI signs at the returned nonce. */
  @Post('payout-runs/:runId/proposal-attempts')
  @OrgApiBody(ClaimProposalSchema)
  @RequirePermission('payouts.prepare')
  claim(
    @Req() req: Request,
    @Param('orgId') orgId: string,
    @Param('runId') runId: string,
    @OrgSession() session: OrgSession,
    @Body() body: unknown,
  ): Promise<ClaimResult> {
    return this.proposals.claim(
      orgId,
      uuid(runId),
      parse(ClaimProposalSchema, body),
      actor(req, session.userId),
    );
  }

  @Post('payout-runs/:runId/proposed')
  @OrgApiBody(ReportProposalSchema)
  @HttpCode(200)
  @RequirePermission('payouts.prepare')
  report(
    @Req() req: Request,
    @Param('orgId') orgId: string,
    @Param('runId') runId: string,
    @OrgSession() session: OrgSession,
    @Body() body: unknown,
  ): Promise<PayoutRunDetail> {
    return this.proposals.report(
      orgId,
      uuid(runId),
      parse(ReportProposalSchema, body),
      actor(req, session.userId),
    );
  }

  /** The claimer, or anyone with payouts.manage (checked in the service); no step-up. */
  @Post('payout-runs/:runId/proposal-attempts/:attemptId/release')
  @HttpCode(200)
  @RequirePermission('payouts.prepare')
  release(
    @Req() req: Request,
    @Param('orgId') orgId: string,
    @Param('runId') runId: string,
    @Param('attemptId') attemptId: string,
    @OrgSession() session: OrgSession,
  ): Promise<PayoutRunDetail> {
    return this.proposals.release(
      orgId,
      uuid(runId),
      uuid(attemptId),
      actor(req, session.userId),
    );
  }

  /** Closes a `needs_review` run after an on-chain check; final. */
  @Post('payout-runs/:runId/resolve')
  @OrgApiBody(ResolvePayoutRunSchema)
  @HttpCode(200)
  @RequirePermission('payouts.manage')
  resolve(
    @Req() req: Request,
    @Param('orgId') orgId: string,
    @Param('runId') runId: string,
    @OrgSession() session: OrgSession,
    @Body() body: unknown,
  ): Promise<PayoutRunDetail> {
    return this.proposals.resolve(
      orgId,
      uuid(runId),
      parse(ResolvePayoutRunSchema, body),
      actor(req, session.userId),
    );
  }

  @Get('payout-runs/:runId/export.csv')
  @RequirePermission('exports.read')
  async exportCsv(
    @Req() req: Request,
    @Res() res: Response,
    @Param('orgId') orgId: string,
    @Param('runId') runId: string,
    @OrgSession() session: OrgSession,
  ): Promise<void> {
    await limitExports(this.rateLimiter, session.userId);
    // read before streaming: pipeline destroys the response on any error, so
    // a failure here must surface as an ordinary error response
    const rows = await this.proposals.exportRun(
      orgId,
      uuid(runId),
      actor(req, session.userId),
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="payout-run.csv"',
    );
    try {
      await this.csv.toCsv(Readable.from(rows), res, {
        header: true,
        cast: csvCast,
        columns: [
          'line',
          'name',
          'recipient',
          'token',
          'symbol',
          'amount',
          'status',
          'safeTxHash',
          'executedTxHash',
        ].map((k) => ({ key: k, header: k })),
      });
    } catch (error) {
      // headers are already sent: log and cut the connection so the client sees a truncated download
      this.logger.error(
        `payout run CSV export failed mid-stream: ${error instanceof Error ? error.message : String(error)}`,
      );
      res.destroy();
    }
  }
}
