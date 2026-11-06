import { Module } from '@nestjs/common';
import { IConfigurationService } from '@/config/configuration.service.interface';
import { getTxAuthHeaders } from '@/datasources/network/auth/tx-auth-headers.helper';
import { FetchNetworkService } from '@/datasources/network/fetch.network.service';
import type { INetworkService } from '@/datasources/network/network.service.interface';
import type { FetchClient } from '@/datasources/network/network.module';
import { FetchClientToken } from '@/datasources/network/network.module';
import { ILoggingService, LoggingService } from '@/logging/logging.interface';
import { CacheFirstDataSource } from '@/datasources/cache/cache.first.data.source';
import { HttpErrorFactory } from '@/datasources/errors/http-error-factory';
import {
  CacheService,
  type ICacheService,
} from '@/datasources/cache/cache.service.interface';

export const TxAuthNetworkService = Symbol('TxAuthNetworkService');
export const TxAuthCacheFirstDataSource = Symbol('TxAuthCacheFirstDataSource');

/**
 * Provides a NetworkService that sends the Transaction Service API key (when configured)
 * and a CacheFirstDataSource that uses it, under their own tokens.
 * They must never be provided as NetworkService / CacheFirstDataSource: other providers
 * of an importing module would then send the key to third-party hosts. Only inject them
 * in clients whose requests go to the Transaction Service of the chain.
 */
@Module({
  providers: [
    {
      provide: TxAuthNetworkService,
      useFactory: (
        client: FetchClient,
        loggingService: ILoggingService,
        configService: IConfigurationService,
      ): FetchNetworkService => {
        const txHeaders = getTxAuthHeaders(configService);
        return new FetchNetworkService(client, loggingService, txHeaders);
      },
      inject: [FetchClientToken, LoggingService, IConfigurationService],
    },
    {
      provide: TxAuthCacheFirstDataSource,
      useFactory: (
        cacheService: ICacheService,
        networkService: INetworkService,
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
      inject: [
        CacheService,
        TxAuthNetworkService,
        LoggingService,
        IConfigurationService,
      ],
    },
    HttpErrorFactory,
  ],
  exports: [TxAuthNetworkService, TxAuthCacheFirstDataSource, HttpErrorFactory],
})
export class TxAuthNetworkModule {}
