import { Module } from '@nestjs/common';
import { TransactionApiManagerModule } from '@/domain/interfaces/transaction-api.manager.interface';
import { BalancesModule } from '@/modules/balances/balances.module';
import { ChainsModule } from '@/modules/chains/chains.module';
import { ActivityModule } from '@/modules/org/activity/activity.module';
import { OrgTransaction } from '@/modules/org/db/org-transaction';
import { PayoutRunsController } from '@/modules/org/payouts/payout-runs.controller';
import { PayoutRunsService } from '@/modules/org/payouts/payout-runs.service';
import { PermissionsModule } from '@/modules/org/permissions/permissions.module';
import { PoliciesModule } from '@/modules/org/policies/policies.module';

/** BalancesModule and ChainsModule mount gateway routes too; the entry's path allowlist (org-main) keeps them unreachable. */
@Module({
  imports: [
    ActivityModule,
    PermissionsModule,
    PoliciesModule,
    BalancesModule,
    ChainsModule,
    TransactionApiManagerModule,
  ],
  controllers: [PayoutRunsController],
  providers: [OrgTransaction, PayoutRunsService],
  exports: [PayoutRunsService],
})
export class PayoutsModule {}
