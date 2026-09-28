import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  NetworkService,
  INetworkService,
} from '@/datasources/network/network.service.interface';
import { IRelayApi } from '@/domain/interfaces/relay-api.interface';
import { IConfigurationService } from '@/config/configuration.service.interface';
import { HttpErrorFactory } from '@/datasources/errors/http-error-factory';
import {
  CacheService,
  ICacheService,
} from '@/datasources/cache/cache.service.interface';
import { RelayCountCache } from '@/modules/relay/datasources/relay-count.cache';
import {
  RelayStatusCode,
  type RelayStatus,
} from '@/modules/relay/domain/entities/relay-status.entity';
import type { Relay } from '@/modules/relay/domain/entities/relay.entity';
import { rawify, type Raw } from '@/validation/entities/raw.entity';
import type { Address } from 'viem';

const GelatoTaskStatusSchema = z.object({
  task: z.object({
    taskState: z.string(),
    transactionHash: z.string().optional(),
  }),
});

@Injectable()
export class GelatoApi extends RelayCountCache implements IRelayApi {
  /**
   * If you are using your own custom gas limit, please add a 150k gas buffer on top of the expected
   * gas usage for the transaction. This is for the Gelato Relay execution overhead, and adding this
   * buffer reduces your chance of the task cancelling before it is executed on-chain.
   * @see https://docs.gelato.network/developer-services/relay/quick-start/optional-parameters
   */
  private static GAS_LIMIT_BUFFER = BigInt(150_000);

  private static readonly TASK_STATES: Record<string, RelayStatusCode> = {
    CheckPending: RelayStatusCode.Pending,
    ExecPending: RelayStatusCode.Submitted,
    WaitingForConfirmation: RelayStatusCode.Submitted,
    ExecSuccess: RelayStatusCode.Included,
    ExecReverted: RelayStatusCode.Reverted,
    Cancelled: RelayStatusCode.Rejected,
  };

  private readonly baseUri: string;

  constructor(
    @Inject(NetworkService)
    private readonly networkService: INetworkService,
    @Inject(IConfigurationService)
    private readonly configurationService: IConfigurationService,
    private readonly httpErrorFactory: HttpErrorFactory,
    @Inject(CacheService) cacheService: ICacheService,
  ) {
    super(cacheService);
    this.baseUri =
      this.configurationService.getOrThrow<string>('relay.baseUri');
  }

  async relay(args: {
    chainId: string;
    to: Address;
    data: string;
    gasLimit: bigint | null;
  }): Promise<Raw<Relay>> {
    const sponsorApiKey = this.configurationService.getOrThrow<string>(
      `relay.apiKey.${args.chainId}`,
    );

    try {
      const url = `${this.baseUri}/relays/v2/sponsored-call`;
      const { data } = await this.networkService.post<Relay>({
        url,
        data: {
          sponsorApiKey,
          chainId: args.chainId,
          target: args.to,
          data: args.data,
          ...(args.gasLimit && {
            gasLimit: this.getRelayGasLimit(args.gasLimit).toString(),
          }),
        },
      });
      return data;
    } catch (error) {
      throw this.httpErrorFactory.from(error);
    }
  }

  async getRelayStatus(args: {
    chainId: string;
    taskId: string;
  }): Promise<Raw<RelayStatus>> {
    try {
      const url = `${this.baseUri}/tasks/status/${args.taskId}`;
      const { data } = await this.networkService.get<unknown>({ url });
      const { task } = GelatoTaskStatusSchema.parse(data);
      const status =
        GelatoApi.TASK_STATES[task.taskState] ?? RelayStatusCode.Pending;
      return rawify({
        status,
        ...(task.transactionHash && {
          receipt: { transactionHash: task.transactionHash },
        }),
      });
    } catch (error) {
      throw this.httpErrorFactory.from(error);
    }
  }

  private getRelayGasLimit(gasLimit: bigint): bigint {
    return gasLimit + GelatoApi.GAS_LIMIT_BUFFER;
  }
}
