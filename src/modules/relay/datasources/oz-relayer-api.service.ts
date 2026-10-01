import {
  Inject,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
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
import type { Address, Hash } from 'viem';
import { IBlockchainApiManager } from '@/domain/interfaces/blockchain-api.manager.interface';

/**
 * Subset of OpenZeppelin Relayer's `ApiResponse<EvmTransactionResponse>`.
 * @see https://github.com/OpenZeppelin/openzeppelin-relayer/blob/main/openapi.json
 */
const OzTransactionResponseSchema = z.object({
  success: z.boolean(),
  error: z.string().nullish(),
  data: z
    .object({
      id: z.string(),
      status: z.enum([
        'canceled',
        'pending',
        'sent',
        'submitted',
        'mined',
        'confirmed',
        'failed',
        'expired',
      ]),
      hash: z.string().nullish(),
      status_reason: z.string().nullish(),
    })
    .optional(),
});

const OzRelayerResponseSchema = z.object({
  success: z.boolean(),
  data: z
    .object({
      paused: z.boolean(),
      system_disabled: z.boolean().nullish(),
      policies: z.object({ min_balance: z.number().nullish() }).nullish(),
    })
    .nullish(),
});

const OzBalanceResponseSchema = z.object({
  success: z.boolean(),
  data: z.object({ balance: z.number() }).nullish(),
});

type OzTransactionStatus = NonNullable<
  z.infer<typeof OzTransactionResponseSchema>['data']
>['status'];

/**
 * Relays through a self-hosted OpenZeppelin Relayer.
 * One relayer id per chain (`relay.ozRelayer.relayerIds`), one bearer key for the instance.
 */
@Injectable()
export class OzRelayerApi extends RelayCountCache implements IRelayApi {
  private static readonly SPEED = 'fast';
  private static readonly AVAILABILITY_TTL_MS = 45_000;

  private readonly baseUri: string;
  private readonly apiKey: string;
  private readonly relayerIds: Record<string, string>;
  // ponytail: per-process cache, each replica asks OZ at most once per TTL; move to Redis if replicas multiply
  private readonly availability = new Map<
    string,
    { available: boolean; expiresAt: number }
  >();

  constructor(
    @Inject(NetworkService)
    private readonly networkService: INetworkService,
    @Inject(IConfigurationService)
    configurationService: IConfigurationService,
    private readonly httpErrorFactory: HttpErrorFactory,
    @Inject(CacheService) cacheService: ICacheService,
    @Inject(IBlockchainApiManager)
    private readonly blockchainApiManager: IBlockchainApiManager,
  ) {
    super(cacheService);
    this.baseUri = configurationService.getOrThrow<string>(
      'relay.ozRelayer.baseUri',
    );
    this.apiKey = configurationService.getOrThrow<string>(
      'relay.ozRelayer.apiKey',
    );
    this.relayerIds = configurationService.getOrThrow<Record<string, string>>(
      'relay.ozRelayer.relayerIds',
    );
  }

  async relay(args: {
    chainId: string;
    to: Address;
    data: string;
    gasLimit: bigint | null;
  }): Promise<Raw<Relay>> {
    const url = `${this.getRelayerUrl(args.chainId)}/transactions`;
    const response = await this.networkService
      .post<unknown>({
        url,
        data: {
          to: args.to,
          value: 0,
          data: args.data,
          speed: OzRelayerApi.SPEED,
          ...(args.gasLimit && {
            gas_limit: OzRelayerApi.toSafeNumber(args.gasLimit),
          }),
        },
        networkRequest: { headers: this.getHeaders() },
      })
      .then(({ data }) => OzTransactionResponseSchema.parse(data))
      .catch((error) => {
        throw this.httpErrorFactory.from(error);
      });
    if (!response.success || !response.data) {
      throw new UnprocessableEntityException(
        response.error ?? 'Relayer rejected the transaction',
      );
    }
    return rawify({ taskId: response.data.id });
  }

  async isAvailable(chainId: string): Promise<boolean> {
    const cached = this.availability.get(chainId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.available;
    }
    const available = await this.fetchAvailability(chainId);
    this.availability.set(chainId, {
      available,
      expiresAt: Date.now() + OzRelayerApi.AVAILABILITY_TTL_MS,
    });
    return available;
  }

  /** Fails closed: an unreachable or malformed relayer counts as unavailable. */
  private async fetchAvailability(chainId: string): Promise<boolean> {
    if (!this.relayerIds[chainId]) {
      return false;
    }
    try {
      const url = this.getRelayerUrl(chainId);
      const networkRequest = { headers: this.getHeaders() };
      // ponytail: balances arrive as JSON numbers, so wei above 2^53 compare with float precision; fine for a threshold check
      const [relayer, balance] = await Promise.all([
        this.networkService
          .get<unknown>({ url, networkRequest })
          .then(({ data }) => OzRelayerResponseSchema.parse(data)),
        this.networkService
          .get<unknown>({ url: `${url}/balance`, networkRequest })
          .then(({ data }) => OzBalanceResponseSchema.parse(data)),
      ]);
      if (
        !relayer.success ||
        !relayer.data ||
        !balance.success ||
        !balance.data
      ) {
        return false;
      }
      const minBalance = relayer.data.policies?.min_balance ?? 0;
      return (
        !relayer.data.paused &&
        !relayer.data.system_disabled &&
        balance.data.balance >= minBalance
      );
    } catch {
      return false;
    }
  }

  async getRelayStatus(args: {
    chainId: string;
    taskId: string;
  }): Promise<Raw<RelayStatus>> {
    const url = `${this.getRelayerUrl(args.chainId)}/transactions/${args.taskId}`;
    const response = await this.networkService
      .get<unknown>({
        url,
        networkRequest: { headers: this.getHeaders() },
      })
      .then(({ data }) => OzTransactionResponseSchema.parse(data))
      .catch((error) => {
        throw this.httpErrorFactory.from(error);
      });
    if (!response.success || !response.data) {
      throw new UnprocessableEntityException(
        response.error ?? 'Relayer returned no transaction',
      );
    }
    const { status, hash } = response.data;
    const resolved = await this.resolveStatus(
      args.chainId,
      status,
      hash ?? null,
    );
    return rawify({
      status: resolved.status,
      ...(resolved.transactionHash && {
        receipt: { transactionHash: resolved.transactionHash },
      }),
    });
  }

  private async resolveStatus(
    chainId: string,
    status: OzTransactionStatus,
    hash: string | null,
  ): Promise<{ status: RelayStatusCode; transactionHash?: string }> {
    if (status === 'canceled' || status === 'expired') {
      return { status: RelayStatusCode.Rejected };
    }
    if (status === 'pending' || status === 'sent') {
      return { status: RelayStatusCode.Pending };
    }
    if (!hash) {
      return {
        status:
          status === 'failed'
            ? RelayStatusCode.Rejected
            : RelayStatusCode.Submitted,
      };
    }
    if (status === 'submitted') {
      return { status: RelayStatusCode.Submitted };
    }

    try {
      const receipt = await (
        await this.blockchainApiManager.getApi(chainId)
      ).getTransactionReceipt({
        hash: hash as Hash,
      });
      if (!receipt) return { status: RelayStatusCode.Submitted };
      if (receipt.status !== 'success' && receipt.status !== 'reverted') {
        return { status: RelayStatusCode.Submitted };
      }
      return {
        status:
          receipt.status === 'reverted'
            ? RelayStatusCode.Reverted
            : RelayStatusCode.Included,
        transactionHash: hash,
      };
    } catch {
      return { status: RelayStatusCode.Submitted };
    }
  }

  private getRelayerUrl(chainId: string): string {
    const relayerId = this.relayerIds[chainId];
    if (!relayerId) {
      throw new UnprocessableEntityException(
        `Relaying is not available on chain ${chainId}`,
      );
    }
    return `${this.baseUri}/api/v1/relayers/${relayerId}`;
  }

  private static toSafeNumber(value: bigint): number {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number <= 0) {
      throw new UnprocessableEntityException('Invalid gas limit');
    }
    return number;
  }

  private getHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}` };
  }
}
