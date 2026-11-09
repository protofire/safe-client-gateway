import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthService } from '@/modules/org/auth/auth.service';
import { CsrfGuard } from '@/modules/org/auth/csrf.guard';
import { SessionGuard } from '@/modules/org/auth/session.guard';
import { SessionsRepository } from '@/modules/org/auth/sessions.repository';
import { SiweAuthController } from '@/modules/org/auth/siwe-auth.controller';
import { StrongAuthGuard } from '@/modules/org/auth/strong-auth.guard';
import { Clock, systemClock } from '@/modules/org/common/clock';
import { RateLimiter } from '@/modules/org/common/rate-limiter';

/**
 * Global so `@RequireStrongAuth()` (StrongAuthGuard and its deps), Clock and
 * RateLimiter resolve in every org feature module. Needs the global
 * CacheService (CacheModule) and the 'org' DataSource.
 */
@Global()
@Module({
  controllers: [SiweAuthController],
  providers: [
    // order matters: CSRF is checked before the session
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: SessionGuard },
    { provide: Clock, useValue: systemClock },
    AuthService,
    RateLimiter,
    SessionsRepository,
    StrongAuthGuard,
  ],
  exports: [AuthService, Clock, RateLimiter, StrongAuthGuard],
})
export class OrgAuthModule {}
