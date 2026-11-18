import { Module } from '@nestjs/common';
import { OrgTransaction } from '@/modules/org/db/org-transaction';
import { PurgeProcessor } from '@/modules/org/jobs/purge.processor';

@Module({
  providers: [OrgTransaction, PurgeProcessor],
  exports: [PurgeProcessor],
})
export class OrgJobsModule {}
