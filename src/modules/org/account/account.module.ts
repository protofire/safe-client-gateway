import { Module } from '@nestjs/common';
import { AccountController } from '@/modules/org/account/account.controller';
import { AccountService } from '@/modules/org/account/account.service';
import { ActivityModule } from '@/modules/org/activity/activity.module';
import { OrgTransaction } from '@/modules/org/db/org-transaction';

@Module({
  imports: [ActivityModule],
  controllers: [AccountController],
  providers: [AccountService, OrgTransaction],
})
export class OrgAccountModule {}
