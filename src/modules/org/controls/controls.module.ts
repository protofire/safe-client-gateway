import { Module } from '@nestjs/common';
import { CsvService } from '@/modules/csv-export/csv-utils/csv.service';
import { ExportApiManagerModule } from '@/modules/csv-export/v1/datasources/export-api.manager.interface';
import { DelegatesV2RepositoryModule } from '@/modules/delegate/domain/v2/delegates.v2.repository.interface';
import { ActivityModule } from '@/modules/org/activity/activity.module';
import { ControlsController } from '@/modules/org/controls/controls.controller';
import { ControlsService } from '@/modules/org/controls/controls.service';
import { OrgTransactionsExportService } from '@/modules/org/controls/org-transactions-export.service';
import { OrgTransaction } from '@/modules/org/db/org-transaction';
import { PermissionsModule } from '@/modules/org/permissions/permissions.module';
import { PoliciesModule } from '@/modules/org/policies/policies.module';
import { SafeRepositoryModule } from '@/modules/safe/domain/safe.repository.interface';

/** Reuses the gateway Safe, delegates and tx-service export clients in-process. */
@Module({
  imports: [
    ActivityModule,
    DelegatesV2RepositoryModule,
    ExportApiManagerModule,
    PermissionsModule,
    PoliciesModule,
    SafeRepositoryModule,
  ],
  controllers: [ControlsController],
  providers: [
    ControlsService,
    CsvService,
    OrgTransaction,
    OrgTransactionsExportService,
  ],
})
export class ControlsModule {}
