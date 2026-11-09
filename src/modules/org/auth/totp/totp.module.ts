import { Module } from '@nestjs/common';
import { FactorsService } from '@/modules/org/auth/totp/factors.service';
import { TotpController } from '@/modules/org/auth/totp/totp.controller';

/** TOTP factors; its deps come from the global OrgAuthModule. */
@Module({
  controllers: [TotpController],
  providers: [FactorsService],
})
export class OrgTotpModule {}
