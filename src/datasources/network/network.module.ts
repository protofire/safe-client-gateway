import { Global, Module } from '@nestjs/common';
import { IConfigurationService } from '@/config/configuration.service.interface';
import { FetchNetworkService } from '@/datasources/network/fetch.network.service';
import { NetworkService } from '@/datasources/network/network.service.interface';
import { NetworkResponse } from '@/datasources/network/entities/network.response.entity';
import {
  NetworkRequestError,
  NetworkResponseError,
} from '@/datasources/network/entities/network.error.entity';
import type { Raw } from '@/validation/entities/raw.entity';
import { ILoggingService, LoggingService } from '@/logging/logging.interface';
import { asError } from '@/logging/utils';

export type FetchClient = <T>(
  url: string,
  options: RequestInit,
) => Promise<NetworkResponse<T>>;

/**
 * Use this factory to create a {@link FetchClient} instance
 * that can be used to make HTTP requests.
 */
function fetchClientFactory(
  configurationService: IConfigurationService,
  loggingService: ILoggingService,
): FetchClient {
  const requestTimeout = configurationService.getOrThrow<number>(
    'httpClient.requestTimeout',
  );

  return async <T>(
    url: string,
    options: RequestInit,
  ): Promise<NetworkResponse<T>> => {
    let urlObject: URL | null = null;
    let response: Response | null = null;

    try {
      urlObject = new URL(url);
      response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(requestTimeout),
        keepalive: true,
      });
    } catch (error) {
      loggingService.debug({
        message: { error: asError(error), errorDetailed: error, url , options,  method: '_clientFactory'},
      });
      throw new NetworkRequestError(urlObject, error);
    }

    // We validate data so don't need worry about casting `null` response
    const data = (await response.json().catch(() => null)) as Raw<T>;

    if (!response.ok) {
      loggingService.debug({error: "response is not okay", response, data, url});
      throw new NetworkResponseError(urlObject, response, data);
    }

    return {
      status: response.status,
      data,
    };
  };
}

/**
 * A {@link Global} Module which provides HTTP support via {@link NetworkService}
 * Feature Modules don't need to import this module directly in order to inject
 * the {@link NetworkService}.
 *
 * This module should be included in the "root" application module
 */
@Global()
@Module({
  providers: [
    {
      provide: 'FetchClient',
      useFactory: fetchClientFactory,
      inject: [IConfigurationService, LoggingService],
    },
    { provide: NetworkService, useClass: FetchNetworkService },
  ],
  exports: [NetworkService],
})
export class NetworkModule {}
