import {
  DynamicModule,
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
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
import { OrgDatabaseModule } from '@/modules/org/db/org-database.module';
import { OrgHealthController } from '@/modules/org/health/org-health.controller';
import { GlobalErrorFilter } from '@/routes/common/filters/global-error.filter';

export const ORG_CACHE_KEY_PREFIX = 'org:';

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
        RequestScopedLoggingModule,
      ],
      controllers: [OrgHealthController],
      providers: [{ provide: APP_FILTER, useClass: GlobalErrorFilter }],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(ClsMiddleware)
      .forRoutes({ path: '{*any}', method: RequestMethod.ALL });
  }
}
