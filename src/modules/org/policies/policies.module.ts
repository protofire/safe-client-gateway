import { Module } from '@nestjs/common';
import { ChainsModule } from '@/modules/chains/chains.module';
import { ActivityModule } from '@/modules/org/activity/activity.module';
import { OrgTransaction } from '@/modules/org/db/org-transaction';
import { PermissionsModule } from '@/modules/org/permissions/permissions.module';
import { PoliciesController } from '@/modules/org/policies/policies.controller';
import { PoliciesService } from '@/modules/org/policies/policies.service';
import { PolicyContextService } from '@/modules/org/policies/policy-context.service';
import { TokensModule } from '@/modules/tokens/tokens.module';

/** ChainsModule mounts gateway routes too; the entry's path allowlist (org-main) keeps them unreachable. */
@Module({
  imports: [ActivityModule, PermissionsModule, ChainsModule, TokensModule],
  controllers: [PoliciesController],
  providers: [OrgTransaction, PoliciesService, PolicyContextService],
  exports: [PolicyContextService],
})
export class PoliciesModule {}
