import { Module } from '@nestjs/common';
import { EmailOtpController } from '@/modules/org/auth/email-otp/email-otp.controller';
import { EmailOtpService } from '@/modules/org/auth/email-otp/email-otp.service';
import { OrgOidcModule } from '@/modules/org/auth/oidc/oidc.module';
import { MailService } from '@/modules/org/mail/mail.service';

/** Email one-time-code sign-in; sessions and identities go through OidcService. */
@Module({
  imports: [OrgOidcModule],
  controllers: [EmailOtpController],
  providers: [EmailOtpService, MailService],
  exports: [EmailOtpService],
})
export class OrgEmailOtpModule {}
