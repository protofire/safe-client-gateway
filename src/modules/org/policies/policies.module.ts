import { Module } from '@nestjs/common';
import { ChainsModule } from '@/modules/chains/chains.module';
import { ActivityModule } from '@/modules/org/activity/activity.module';
import { OrgTransaction } from '@/modules/org/db/org-transaction';
import { PermissionsModule } from '@/modules/org/permissions/permissions.module';
import { FindingsController } from '@/modules/org/policies/findings.controller';
import { PoliciesController } from '@/modules/org/policies/policies.controller';
import { PoliciesService } from '@/modules/org/policies/policies.service';
import { PolicyContextService } from '@/modules/org/policies/policy-context.service';
import { PolicyScanner } from '@/modules/org/policies/policy-scanner';
import { SafeRepositoryModule } from '@/modules/safe/domain/safe.repository.interface';
import { TransactionApiManagerModule } from '@/domain/interfaces/transaction-api.manager.interface';

/** ChainsModule mounts gateway routes too; the entry's path allowlist (org-main) keeps them unreachable. */
@Module({
  imports: [
    ActivityModule,
    PermissionsModule,
    ChainsModule,
    TransactionApiManagerModule,
    SafeRepositoryModule,
  ],
  controllers: [PoliciesController, FindingsController],
  providers: [
    OrgTransaction,
    PoliciesService,
    PolicyContextService,
    PolicyScanner,
  ],
  exports: [PolicyContextService, PolicyScanner],
})
export class PoliciesModule {}
