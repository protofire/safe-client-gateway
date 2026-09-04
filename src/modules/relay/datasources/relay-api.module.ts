import { Module } from '@nestjs/common';
import { GelatoApi } from '@/modules/relay/datasources/gelato-api.service';
import { OzRelayerApi } from '@/modules/relay/datasources/oz-relayer-api.service';
import { IRelayApi } from '@/domain/interfaces/relay-api.interface';
import { HttpErrorFactory } from '@/datasources/errors/http-error-factory';
import { IConfigurationService } from '@/config/configuration.service.interface';

export type RelayProvider = 'gelato' | 'oz-relayer';

@Module({
  providers: [
    HttpErrorFactory,
    GelatoApi,
    OzRelayerApi,
    {
      provide: IRelayApi,
      useFactory: (
        configurationService: IConfigurationService,
        gelatoApi: GelatoApi,
        ozRelayerApi: OzRelayerApi,
      ): IRelayApi => {
        const provider =
          configurationService.getOrThrow<RelayProvider>('relay.provider');
        return provider === 'oz-relayer' ? ozRelayerApi : gelatoApi;
      },
      inject: [IConfigurationService, GelatoApi, OzRelayerApi],
    },
  ],
  exports: [IRelayApi],
})
export class RelayApiModule {}
