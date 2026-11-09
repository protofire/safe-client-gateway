import {
  DynamicModule,
  MiddlewareConsumer,
  Module,
  NestModule,
  type Provider,
  RequestMethod,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { CacheModule as InMemoryCacheModule } from '@nestjs/cache-manager';
import { ClsMiddleware, ClsModule } from 'nestjs-cls';
import { ConfigurationModule } from '@/config/configuration.module';
import { BlocklistModule } from '@/config/entities/blocklist.module';
import orgConfiguration from '@/config/org/org-configuration';
import { OrgConfigurationSchema } from '@/config/org/org-configuration.schema';
import { CacheModule } from '@/datasources/cache/cache.module';
import { CircuitBreakerModule } from '@/datasources/circuit-breaker/circuit-breaker.module';
import { NetworkModule } from '@/datasources/network/network.module';
import { RequestScopedLoggingModule } from '@/logging/logging.module';
import { CsrfGuard } from '@/modules/org/auth/csrf.guard';
import { OrgAuthModule } from '@/modules/org/auth/org-auth.module';
import { OrgOidcModule } from '@/modules/org/auth/oidc/oidc.module';
import { OrgTotpModule } from '@/modules/org/auth/totp/totp.module';
import { SessionGuard } from '@/modules/org/auth/session.guard';
import { OrgDatabaseModule } from '@/modules/org/db/org-database.module';
import { OrgHealthController } from '@/modules/org/health/org-health.controller';
import { OrgMemberGuard } from '@/modules/org/permissions/org-member.guard';
import { PermissionsModule } from '@/modules/org/permissions/permissions.module';
import { GlobalErrorFilter } from '@/routes/common/filters/global-error.filter';
import { ZodErrorFilter } from '@/routes/common/filters/zod-error.filter';

export const ORG_CACHE_KEY_PREFIX = 'org:';

/**
 * The single source of global guard order: Nest runs APP_GUARDs in
 * registration order (pinned by org-guards.integration.spec.ts). CSRF first,
 * so a forged request never reaches a session lookup; the session before the
 * tenant guard, which needs `req.orgSession`. Route-level guards
 * (`@RequireStrongAuth()`) run after all of these.
 */
export const ORG_APP_GUARDS: Array<Provider> = [
  { provide: APP_GUARD, useClass: CsrfGuard },
  { provide: APP_GUARD, useClass: SessionGuard },
  { provide: APP_GUARD, useClass: OrgMemberGuard },
];

/**
 * Root module of cgw-org: Organization API, own Redis/Postgres/AMQP, own
 * configuration. Feature modules are added to `imports` by later tasks.
 */
@Module({})
export class OrgAppModule implements NestModule {
  static register(configFactory = orgConfiguration): DynamicModule {
    return {
      module: OrgAppModule,
      imports: [
        // Required by TransactionVerifierHelper in the reused Safe repositories
        BlocklistModule,
        CacheModule.register(ORG_CACHE_KEY_PREFIX),
        CircuitBreakerModule,
        ClsModule.forRoot({
          global: true,
          middleware: {
            generateId: true,
            idGenerator: () => crypto.randomUUID(),
          },
        }),
        ConfigurationModule.register(configFactory, OrgConfigurationSchema, {
          ignoreEnvFile: true,
        }),
        InMemoryCacheModule.register({ isGlobal: true }),
        NetworkModule,
        OrgDatabaseModule,
        PermissionsModule,
        RequestScopedLoggingModule,
        // Route modules. Express matches in registration order: modules with
        // static paths (auth, account, invitations) come before any module
        // with /v1/orgs/:orgId routes, or `auth` would be taken for an orgId.
        OrgAuthModule,
        OrgOidcModule,
        OrgTotpModule,
      ],
      controllers: [OrgHealthController],
      providers: [
        { provide: APP_FILTER, useClass: GlobalErrorFilter },
        { provide: APP_FILTER, useClass: ZodErrorFilter },
        ...ORG_APP_GUARDS,
      ],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(ClsMiddleware)
      .forRoutes({ path: '{*any}', method: RequestMethod.ALL });
  }
}
