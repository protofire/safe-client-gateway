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
import { IChainsRepository } from '@/modules/chains/domain/chains.repository.interface';
import { RELAYER_ID_PATTERN } from '@/modules/relay/domain/entities/gas-token.configuration';

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
      policies: z
        .object({
          min_balance: z.number().nullish(),
          // A cap above 2^53, a string or 0 must not fail the whole parse (and with it availability):
          // only the budgeted modes depend on it
          gas_price_cap: z.number().int().positive().nullish().catch(null),
        })
        .nullish(),
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

type RelayerState = { available: boolean; gasPriceCap: bigint | null };

/**
 * Relays through a self-hosted OpenZeppelin Relayer.
 * One OZ relayer per chain (the chain's relay settings in config-service), one bearer key for the instance.
 */
@Injectable()
export class OzRelayerApi extends RelayCountCache implements IRelayApi {
  private static readonly SPEED = 'fast';
  private static readonly AVAILABILITY_TTL_MS = 45_000;
  private static readonly OZ_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/;

  private static readonly UNAVAILABLE: RelayerState = {
    available: false,
    gasPriceCap: null,
  };

  private readonly baseUri: string;
  private readonly apiKey: string;
  // Keyed by relayer id, not chain id: an admin edit of a chain's relayer id takes effect immediately.
  // ponytail: per-process cache, each replica asks OZ at most once per TTL; move to Redis if replicas multiply
  private readonly states = new Map<
    string,
    RelayerState & { expiresAt: number }
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
    @Inject(IChainsRepository)
    private readonly chainsRepository: IChainsRepository,
  ) {
    super(cacheService);
    this.baseUri = configurationService.getOrThrow<string>(
      'relay.ozRelayer.baseUri',
    );
    this.apiKey = configurationService.getOrThrow<string>(
      'relay.ozRelayer.apiKey',
    );
  }

  async relay(args: {
    chainId: string;
    to: Address;
    data: string;
    gasLimit: bigint | null;
  }): Promise<Raw<Relay>> {
    const relayerId = await this.getRelayerId(args.chainId);
    if (!relayerId) {
      throw OzRelayerApi.notAvailable(args.chainId);
    }
    const url = `${this.toRelayerUrl(relayerId)}/transactions`;
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
    // The relayer travels in the task id so status polling does not depend on the settings at poll time
    return rawify({ taskId: `${relayerId}:${response.data.id}` });
  }

  async isAvailable(chainId: string): Promise<boolean> {
    return (await this.getRelayerState(chainId)).available;
  }

  async getGasPriceCap(chainId: string): Promise<bigint | null> {
    return (await this.getRelayerState(chainId)).gasPriceCap;
  }

  /** Fails closed: missing or unreadable relay settings count as unavailable (not cached: settings have their own cache). */
  private async getRelayerState(chainId: string): Promise<RelayerState> {
    let relayerId: string | null;
    try {
      relayerId = await this.getRelayerId(chainId);
    } catch {
      return OzRelayerApi.UNAVAILABLE;
    }
    if (!relayerId) {
      return OzRelayerApi.UNAVAILABLE;
    }
    const cached = this.states.get(relayerId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached;
    }
    const state = await this.fetchRelayerState(relayerId);
    this.states.set(relayerId, {
      ...state,
      expiresAt: Date.now() + OzRelayerApi.AVAILABILITY_TTL_MS,
    });
    return state;
  }

  /** Fails closed: an unreachable or malformed relayer counts as unavailable. */
  private async fetchRelayerState(relayerId: string): Promise<RelayerState> {
    try {
      const url = this.toRelayerUrl(relayerId);
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
        return OzRelayerApi.UNAVAILABLE;
      }
      const policies = relayer.data.policies;
      const gasPriceCap = policies?.gas_price_cap;
      return {
        available:
          !relayer.data.paused &&
          !relayer.data.system_disabled &&
          balance.data.balance >= (policies?.min_balance ?? 0),
        gasPriceCap: gasPriceCap ? BigInt(gasPriceCap) : null,
      };
    } catch {
      return OzRelayerApi.UNAVAILABLE;
    }
  }

  async getRelayStatus(args: {
    chainId: string;
    taskId: string;
  }): Promise<Raw<RelayStatus>> {
    const url = await this.getTransactionUrl(args);
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

  private async getRelayerId(chainId: string): Promise<string | null> {
    const relayChain = await this.chainsRepository.getRelayChain(chainId);
    return relayChain?.relayerId ?? null;
  }

  /** `<relayerId>:<ozId>` from relay(); a task id without ':' predates that format and uses the chain's current relayer. */
  private async getTransactionUrl(args: {
    chainId: string;
    taskId: string;
  }): Promise<string> {
    const separator = args.taskId.indexOf(':');
    // Without ':' (separator -1) this is the whole id
    const ozId = args.taskId.slice(separator + 1);
    if (!OzRelayerApi.OZ_ID_PATTERN.test(ozId)) {
      throw new UnprocessableEntityException('Invalid task id');
    }
    if (separator === -1) {
      return `${await this.getRelayerUrl(args.chainId)}/transactions/${ozId}`;
    }
    const relayerId = args.taskId.slice(0, separator);
    if (!RELAYER_ID_PATTERN.test(relayerId)) {
      throw new UnprocessableEntityException('Invalid task id');
    }
    return `${this.toRelayerUrl(relayerId)}/transactions/${ozId}`;
  }

  private async getRelayerUrl(chainId: string): Promise<string> {
    const relayerId = await this.getRelayerId(chainId);
    if (!relayerId) {
      throw OzRelayerApi.notAvailable(chainId);
    }
    return this.toRelayerUrl(relayerId);
  }

  private static notAvailable(chainId: string): UnprocessableEntityException {
    return new UnprocessableEntityException(
      `Relaying is not available on chain ${chainId}`,
    );
  }

  private toRelayerUrl(relayerId: string): string {
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
