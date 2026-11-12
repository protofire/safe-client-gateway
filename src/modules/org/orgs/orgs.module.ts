import { Module } from '@nestjs/common';
import { ActivityModule } from '@/modules/org/activity/activity.module';
import { OrgTransaction } from '@/modules/org/db/org-transaction';
import { MailService } from '@/modules/org/mail/mail.service';
import { SecurityNotifier } from '@/modules/org/mail/security-notifier';
import { OrgsController } from '@/modules/org/orgs/orgs.controller';
import { OrgsService } from '@/modules/org/orgs/orgs.service';
import { PermissionsModule } from '@/modules/org/permissions/permissions.module';

@Module({
  imports: [ActivityModule, PermissionsModule],
  controllers: [OrgsController],
  providers: [MailService, OrgsService, OrgTransaction, SecurityNotifier],
})
export class OrgsModule {}
