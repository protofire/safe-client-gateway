import { Module } from '@nestjs/common';
import { BalancesModule } from '@/modules/balances/balances.module';
import { ChainsModule } from '@/modules/chains/chains.module';
import { SafeRepositoryModule } from '@/modules/safe/domain/safe.repository.interface';
import { ActivityModule } from '@/modules/org/activity/activity.module';
import { OrgTransaction } from '@/modules/org/db/org-transaction';
import { PermissionsModule } from '@/modules/org/permissions/permissions.module';
import { LinkedSafesController } from '@/modules/org/safes/linked-safes.controller';
import { LinkedSafesService } from '@/modules/org/safes/linked-safes.service';
import { OverviewService } from '@/modules/org/safes/overview.service';

/**
 * Reuses the gateway Safe, chains and balances repositories in-process.
 * BalancesModule is the only exporter of IBalancesRepository and also mounts
 * the gateway's balances routes; the entry's path allowlist (org-main) keeps
 * them unreachable.
 */
@Module({
  imports: [ActivityModule, PermissionsModule, BalancesModule, ChainsModule, SafeRepositoryModule],
  controllers: [LinkedSafesController],
  providers: [OrgTransaction, LinkedSafesService, OverviewService],
})
export class SafesModule {}
