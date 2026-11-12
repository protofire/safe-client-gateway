import { Module } from '@nestjs/common';
import { TransactionApiManagerModule } from '@/domain/interfaces/transaction-api.manager.interface';
import { BalancesModule } from '@/modules/balances/balances.module';
import { BlockchainModule } from '@/modules/blockchain/blockchain.module';
import { ChainsModule } from '@/modules/chains/chains.module';
import { CsvService } from '@/modules/csv-export/csv-utils/csv.service';
import { ActivityModule } from '@/modules/org/activity/activity.module';
import { OrgTransaction } from '@/modules/org/db/org-transaction';
import { PayoutProposalsService } from '@/modules/org/payouts/payout-proposals.service';
import { PayoutRunsController } from '@/modules/org/payouts/payout-runs.controller';
import { PayoutRunsService } from '@/modules/org/payouts/payout-runs.service';
import { PayoutStatusUpdater } from '@/modules/org/payouts/payout-status.updater';
import { PermissionsModule } from '@/modules/org/permissions/permissions.module';
import { PoliciesModule } from '@/modules/org/policies/policies.module';
import { SafeRepositoryModule } from '@/modules/safe/domain/safe.repository.interface';

/** BalancesModule and ChainsModule mount gateway routes too; the entry's path allowlist (org-main) keeps them unreachable. */
@Module({
  imports: [
    ActivityModule,
    PermissionsModule,
    PoliciesModule,
    BalancesModule,
    BlockchainModule,
    ChainsModule,
    TransactionApiManagerModule,
    SafeRepositoryModule,
  ],
  controllers: [PayoutRunsController],
  providers: [
    OrgTransaction,
    PayoutRunsService,
    PayoutProposalsService,
    PayoutStatusUpdater,
    CsvService,
  ],
  exports: [PayoutRunsService, PayoutStatusUpdater],
})
export class PayoutsModule {}
