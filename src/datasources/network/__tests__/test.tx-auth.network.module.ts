import { Module } from '@nestjs/common';
import type { INetworkService } from '@/datasources/network/network.service.interface';
import { CacheFirstDataSource } from '@/datasources/cache/cache.first.data.source';
import { HttpErrorFactory } from '@/datasources/errors/http-error-factory';
import { networkService } from '@/datasources/network/__tests__/test.network.module';
import {
  TxAuthCacheFirstDataSource,
  TxAuthNetworkService,
} from '@/datasources/network/tx-auth.network.module';
import {
  CacheService,
  type ICacheService,
} from '@/datasources/cache/cache.service.interface';
import { ILoggingService, LoggingService } from '@/logging/logging.interface';
import { IConfigurationService } from '@/config/configuration.service.interface';

/**
 * Test module that overrides {@link TxAuthNetworkModule} with mocked dependencies.
 *
 * Key points:
 * - Reuses the same NetworkService mock instance from {@link TestNetworkModule}
 * - Exports a real CacheFirstDataSource (with the mocked NetworkService injected) & HttpErrorFactory
 * - Required by TransactionApiManager and other consumers that inject these dependencies
 */
@Module({
  providers: [
    {
      provide: TxAuthNetworkService,
      useFactory: (): jest.MockedObjectDeep<INetworkService> => {
        return jest.mocked(networkService);
      },
    },
    {
      provide: TxAuthCacheFirstDataSource,
      useFactory: (
        cacheService: ICacheService,
        loggingService: ILoggingService,
        configService: IConfigurationService,
      ): CacheFirstDataSource => {
        return new CacheFirstDataSource(
          cacheService,
          networkService,
          loggingService,
          configService,
        );
      },
      inject: [CacheService, LoggingService, IConfigurationService],
    },
    HttpErrorFactory,
  ],
  exports: [TxAuthNetworkService, TxAuthCacheFirstDataSource, HttpErrorFactory],
})
export class TestTxAuthNetworkModule {}
