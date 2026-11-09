import { Module } from '@nestjs/common';
import { BalancesModule } from '@/modules/balances/balances.module';
import { SafeRepositoryModule } from '@/modules/safe/domain/safe.repository.interface';
import { ActivityModule } from '@/modules/org/activity/activity.module';
import { OrgTransaction } from '@/modules/org/db/org-transaction';
import { OrgEventsConsumer } from '@/modules/org/events/org-events.consumer';
import { OrgEventsHandler } from '@/modules/org/events/org-events.handler';
import { OrgEventsReconciler } from '@/modules/org/events/org-events.reconciler';

@Module({
  imports: [ActivityModule, BalancesModule, SafeRepositoryModule],
  providers: [
    OrgTransaction,
    OrgEventsHandler,
    OrgEventsConsumer,
    OrgEventsReconciler,
  ],
})
export class OrgEventsModule {}
