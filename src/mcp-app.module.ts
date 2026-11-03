import {
  DynamicModule,
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { CacheModule as InMemoryCacheModule } from '@nestjs/cache-manager';
import { ScheduleModule } from '@nestjs/schedule';
import { ClsMiddleware, ClsModule } from 'nestjs-cls';
import { BlocklistModule } from '@/config/entities/blocklist.module';
import { ConfigurationModule } from '@/config/configuration.module';
import configuration from '@/config/entities/configuration';
import { CacheModule } from '@/datasources/cache/cache.module';
import { CircuitBreakerModule } from '@/datasources/circuit-breaker/circuit-breaker.module';
import { NetworkModule } from '@/datasources/network/network.module';
import { McpLoggingModule } from '@/modules/mcp/logging/mcp-logging.module';
import { McpModule } from '@/modules/mcp/mcp.module';
import { McpHealthController } from '@/modules/mcp/routes/mcp-health.controller';
import { GlobalErrorFilter } from '@/routes/common/filters/global-error.filter';

/**
 * Root module of cgw-mcp: shares the Redis cache with cgw and nothing else.
 * No Postgres, AMQP or BullMQ, and no RouteLoggerInterceptor (it logs client_ip).
 */
@Module({})
export class McpAppModule implements NestModule {
  static register(configFactory = configuration): DynamicModule {
    return {
      module: McpAppModule,
      imports: [
        // features
        McpModule,
        // common
        // Required by TransactionVerifierHelper in SafeRepositoryModule and by MCP tools
        BlocklistModule,
        CacheModule,
        CircuitBreakerModule,
        // Module for storing and reading from the async local storage
        ClsModule.forRoot({
          global: true,
          middleware: {
            generateId: true,
            idGenerator: () => crypto.randomUUID(),
          },
        }),
        ConfigurationModule.register(configFactory),
        InMemoryCacheModule.register({ isGlobal: true }),
        NetworkModule,
        McpLoggingModule,
        // Circuit-breaker cleanup is a @Cron job
        ScheduleModule.forRoot(),
      ],
      controllers: [McpHealthController],
      providers: [{ provide: APP_FILTER, useClass: GlobalErrorFilter }],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(ClsMiddleware)
      .forRoutes({ path: '{*any}', method: RequestMethod.ALL });
  }
}
