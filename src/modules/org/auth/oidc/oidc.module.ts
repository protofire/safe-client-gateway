import { Module } from '@nestjs/common';
import { OidcClient } from '@/modules/org/auth/oidc/oidc.client';
import { OidcController } from '@/modules/org/auth/oidc/oidc.controller';
import { OidcService } from '@/modules/org/auth/oidc/oidc.service';

/** Auth0 sign-in; its deps come from the global OrgAuthModule. */
@Module({
  controllers: [OidcController],
  providers: [OidcClient, OidcService],
  exports: [OidcService],
})
export class OrgOidcModule {}
