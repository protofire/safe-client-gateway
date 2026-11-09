import { Global, Module } from '@nestjs/common';
import { AuthService } from '@/modules/org/auth/auth.service';
import {
  NonceStore,
  ORG_REDIS,
  orgRedisProvider,
} from '@/modules/org/auth/nonce.store';
import { SecurityEvents } from '@/modules/org/auth/security-events';
import { SessionsRepository } from '@/modules/org/auth/sessions.repository';
import { SiweAuthController } from '@/modules/org/auth/siwe-auth.controller';
import { StrongAuthGuard } from '@/modules/org/auth/strong-auth.guard';
import { Clock, systemClock } from '@/modules/org/common/clock';
import { RateLimiter } from '@/modules/org/common/rate-limiter';
import { FieldEncryptionService } from '@/modules/org/crypto/field-encryption.service';

/**
 * Global so `@RequireStrongAuth()` (StrongAuthGuard and its deps), Clock,
 * RateLimiter and SessionsRepository (for the global SessionGuard, registered
 * with CsrfGuard in OrgAppModule's ORG_APP_GUARDS) resolve everywhere. Needs the global
 * CacheService (CacheModule) and the 'org' DataSource; opens its own Redis
 * connection (ORG_REDIS) for SIWE nonces and OIDC state.
 */
@Global()
@Module({
  controllers: [SiweAuthController],
  providers: [
    { provide: Clock, useValue: systemClock },
    AuthService,
    FieldEncryptionService,
    NonceStore,
    orgRedisProvider,
    RateLimiter,
    SecurityEvents,
    SessionsRepository,
    StrongAuthGuard,
  ],
  exports: [
    AuthService,
    Clock,
    FieldEncryptionService,
    ORG_REDIS,
    RateLimiter,
    SecurityEvents,
    SessionsRepository,
    StrongAuthGuard,
  ],
})
export class OrgAuthModule {}
