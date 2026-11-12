import { Module } from '@nestjs/common';
import { AccountController } from '@/modules/org/account/account.controller';
import { AccountService } from '@/modules/org/account/account.service';
import { LinkIdentityController } from '@/modules/org/account/link-identity.controller';
import { ActivityModule } from '@/modules/org/activity/activity.module';
import { OrgEmailOtpModule } from '@/modules/org/auth/email-otp/email-otp.module';
import { OrgOidcModule } from '@/modules/org/auth/oidc/oidc.module';
import { OrgTransaction } from '@/modules/org/db/org-transaction';

@Module({
  imports: [ActivityModule, OrgOidcModule, OrgEmailOtpModule],
  controllers: [AccountController, LinkIdentityController],
  providers: [AccountService, OrgTransaction],
})
export class OrgAccountModule {}
