import { Module } from '@nestjs/common';
import { ActivityModule } from '@/modules/org/activity/activity.module';
import { OrgTransaction } from '@/modules/org/db/org-transaction';
import { MailService } from '@/modules/org/mail/mail.service';
import { InvitationsController } from '@/modules/org/members/invitations.controller';
import { InvitationsService } from '@/modules/org/members/invitations.service';
import { MembersController } from '@/modules/org/members/members.controller';
import { MembersService } from '@/modules/org/members/members.service';
import { PermissionsModule } from '@/modules/org/permissions/permissions.module';

/** InvitationsController (static `/v1/orgs/invitations/*`) is listed first: route order. */
@Module({
  imports: [ActivityModule, PermissionsModule],
  controllers: [InvitationsController, MembersController],
  providers: [InvitationsService, MailService, MembersService, OrgTransaction],
})
export class MembersModule {}
