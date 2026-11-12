import { Controller, Get, Param, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { OrgSession } from '@/modules/org/auth/decorators';
import {
  ControlsService,
  type ControlsSafe,
} from '@/modules/org/controls/controls.service';
import {
  OrgTransactionsExportService,
  RangeSchema,
} from '@/modules/org/controls/org-transactions-export.service';
import { RequirePermission } from '@/modules/org/permissions/require-permission.decorator';
import { OrgApiQuery } from '@/modules/org/common/org-api-body.decorator';

@Controller({ path: 'orgs/:orgId', version: '1' })
export class ControlsController {
  constructor(
    private readonly controls: ControlsService,
    private readonly exporter: OrgTransactionsExportService,
  ) {}

  @Get('controls')
  @RequirePermission('safes.view')
  list(@Param('orgId') orgId: string): Promise<Array<ControlsSafe>> {
    return this.controls.list(orgId);
  }

  @Get('transactions.csv')
  @OrgApiQuery(RangeSchema)
  @RequirePermission('exports.read')
  exportCsv(
    @Req() req: Request,
    @Res() res: Response,
    @OrgSession() session: OrgSession,
    @Query() query: unknown,
  ): Promise<void> {
    return this.exporter.stream(
      req.params.orgId,
      query,
      req,
      res,
      session.userId,
    );
  }
}
