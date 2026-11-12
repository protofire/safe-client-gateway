import { Module } from '@nestjs/common';
import { OidcClient } from '@/modules/org/auth/oidc/oidc.client';
import { OidcController } from '@/modules/org/auth/oidc/oidc.controller';
import { OidcService } from '@/modules/org/auth/oidc/oidc.service';

/** Google sign-in (OIDC); its deps come from the global OrgAuthModule. */
@Module({
  controllers: [OidcController],
  providers: [OidcClient, OidcService],
  exports: [OidcService],
})
export class OrgOidcModule {}
