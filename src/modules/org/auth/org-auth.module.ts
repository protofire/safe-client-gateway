import { Global, Module } from '@nestjs/common';
import { AuthService } from '@/modules/org/auth/auth.service';
import { NonceStore, orgRedisProvider } from '@/modules/org/auth/nonce.store';
import { SessionsRepository } from '@/modules/org/auth/sessions.repository';
import { SiweAuthController } from '@/modules/org/auth/siwe-auth.controller';
import { StrongAuthGuard } from '@/modules/org/auth/strong-auth.guard';
import { Clock, systemClock } from '@/modules/org/common/clock';
import { RateLimiter } from '@/modules/org/common/rate-limiter';

/**
 * Global so `@RequireStrongAuth()` (StrongAuthGuard and its deps), Clock,
 * RateLimiter and SessionsRepository (for the global SessionGuard, registered
 * with CsrfGuard in OrgAppModule's ORG_APP_GUARDS) resolve everywhere. Needs the global
 * CacheService (CacheModule) and the 'org' DataSource; opens its own Redis
 * connection for nonces (NonceStore).
 */
@Global()
@Module({
  controllers: [SiweAuthController],
  providers: [
    { provide: Clock, useValue: systemClock },
    AuthService,
    NonceStore,
    orgRedisProvider,
    RateLimiter,
    SessionsRepository,
    StrongAuthGuard,
  ],
  exports: [
    AuthService,
    Clock,
    RateLimiter,
    SessionsRepository,
    StrongAuthGuard,
  ],
})
export class OrgAuthModule {}
