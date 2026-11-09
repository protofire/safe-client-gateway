import { Module } from '@nestjs/common';
import { ActivityModule } from '@/modules/org/activity/activity.module';
import { OrgTransaction } from '@/modules/org/db/org-transaction';
import { OrgsController } from '@/modules/org/orgs/orgs.controller';
import { OrgsService } from '@/modules/org/orgs/orgs.service';

@Module({
  imports: [ActivityModule],
  controllers: [OrgsController],
  providers: [OrgsService, OrgTransaction],
})
export class OrgsModule {}
