import { Inject, Injectable } from '@nestjs/common';
import { getAddress, type Address, type Hex } from 'viem';
import { IRelayer } from '@/modules/relay/domain/interfaces/relayer.interface';
import { IConfigurationService } from '@/config/configuration.service.interface';
import { IRelayApi } from '@/domain/interfaces/relay-api.interface';
import { IBlockchainApiManager } from '@/domain/interfaces/blockchain-api.manager.interface';
import { CacheService } from '@/datasources/cache/cache.service.interface';
import type { ICacheService } from '@/datasources/cache/cache.service.interface';
import { IChainsRepository } from '@/modules/chains/domain/chains.repository.interface';
import { LimitAddressesMapper } from '@/modules/relay/domain/limit-addresses.mapper';
import { ILoggingService, LoggingService } from '@/logging/logging.interface';
import {
  Relay,
  RelaySchema,
} from '@/modules/relay/domain/entities/relay.entity';
import type { GasTokenConfiguration } from '@/modules/relay/domain/entities/gas-token.configuration';
import type {
  SponsoredChainConfiguration,
  SponsoredChainsConfiguration,
} from '@/modules/relay/domain/entities/sponsored-chains.configuration';
import { GasTokenFeeService } from '@/modules/relay/domain/gas-token-fee.service';
import { RelayLimitReachedError } from '@/modules/relay/domain/errors/relay-limit-reached.error';
import { ExceedsMaxGasLimitError } from '@/modules/relay/domain/errors/exceeds-max-gas-limit';
import { GasTokenRelayError } from '@/modules/relay/domain/errors/gas-token-relay.error';
import { SafeDecoder } from '@/modules/contracts/domain/decoders/safe-decoder.helper';
import { MultiSendDecoder } from '@/modules/contracts/domain/decoders/multi-send-decoder.helper';
import { ProxyFactoryDecoder } from '@/modules/relay/domain/contracts/decoders/proxy-factory-decoder.helper';

/**
 * Relays `gasPrice == 0` transactions paid by the relayer ("sponsored").
 * Only chains carrying RELAYING and listed in `relay.sponsoredChains` are sponsored; each relay
 * is simulated, capped in gas, counted per limited address and reserved on the chain's daily budget.
 */
@Injectable()
export class DailyLimitRelayer implements IRelayer {
  static readonly FEATURE = 'RELAYING';
  private static readonly COUNT_TTL_SECONDS = 48 * 60 * 60;
  private readonly sponsoredChains: SponsoredChainsConfiguration;
  private readonly gasLimitBuffer: bigint;

  constructor(
    @Inject(LoggingService) private readonly loggingService: ILoggingService,
    @Inject(IConfigurationService) configurationService: IConfigurationService,
    private readonly limitAddressesMapper: LimitAddressesMapper,
    @Inject(IRelayApi) private readonly relayApi: IRelayApi,
    @Inject(IChainsRepository)
    private readonly chainsRepository: IChainsRepository,
    @Inject(IBlockchainApiManager)
    private readonly blockchainApiManager: IBlockchainApiManager,
    @Inject(CacheService) private readonly cacheService: ICacheService,
    private readonly feeService: GasTokenFeeService,
    private readonly safeDecoder: SafeDecoder,
    private readonly multiSendDecoder: MultiSendDecoder,
    private readonly proxyFactoryDecoder: ProxyFactoryDecoder,
  ) {
    this.sponsoredChains = configurationService.getOrThrow(
      'relay.sponsoredChains',
    );
    this.gasLimitBuffer = BigInt(
      configurationService.getOrThrow<GasTokenConfiguration>('relay.gasToken')
        .gasLimitBuffer,
    );
  }

  async canRelay(args: {
    chainId: string;
    address: Address;
  }): Promise<{ result: boolean; currentCount: number; limit: number }> {
    const { remaining, limit } = await this.getRelaysRemaining(args);
    return { result: remaining > 0, currentCount: limit - remaining, limit };
  }

  async relay(args: {
    version: string;
    chainId: string;
    to: Address;
    data: Address;
    gasLimit: bigint | null;
  }): Promise<Relay> {
    const config = await this.getSponsoredChain(args.chainId);
    if (!config) {
      throw new GasTokenRelayError(
        'Sponsored transactions are not available on this network. Execute with your connected wallet.',
        'CHAIN_NOT_SPONSORED',
      );
    }
    const limitAddresses =
      await this.limitAddressesMapper.getLimitAddresses(args);
    const kind = this.getKind(args.data);

    const estimate = await this.feeService.simulate({
      chainId: args.chainId,
      safeAddress: args.to,
      data: args.data,
      checkSafeResult: kind === 'exec',
    });
    const simulatedLimit = estimate + this.gasLimitBuffer;
    const gasLimit =
      args.gasLimit && args.gasLimit > simulatedLimit
        ? args.gasLimit
        : simulatedLimit;
    const maxGasLimit = BigInt(config.maxGasLimit);
    if (gasLimit > maxGasLimit) {
      throw new ExceedsMaxGasLimitError(gasLimit, maxGasLimit);
    }

    // ponytail: slots reserved here are not released when a later address, the budget or the relayer refuses; at most one lost slot per refused attempt, release on refusal if users hit it
    const countKind = kind === 'creation' ? 'creation' : 'safe';
    const limit =
      countKind === 'creation'
        ? config.perOwnerCreationsPerDay
        : config.perSafePerDay;
    for (const address of limitAddresses) {
      const count = await this.cacheService.increment(
        this.countKey(args.chainId, countKind, address),
        DailyLimitRelayer.COUNT_TTL_SECONDS,
        0,
      );
      if (count > limit) {
        const error = new RelayLimitReachedError(address, count - 1, limit);
        this.loggingService.info(error.message);
        throw error;
      }
    }

    const budget = await this.feeService.reserveGasBudget({
      key: GasTokenFeeService.dayKey('sponsored-spend', args.chainId),
      outerGasLimit: gasLimit,
      dailyLimitGwei: config.dailyBudgetGwei,
      maxGasPriceWei: config.maxGasPriceWei,
    });
    if (budget !== 'reserved') {
      throw new GasTokenRelayError(
        "Today's sponsored gas on this network is used up. Execute with your connected wallet or try again tomorrow.",
        'BUDGET_EXHAUSTED',
      );
    }

    const relay = await this.relayApi
      .relay({ chainId: args.chainId, to: args.to, data: args.data, gasLimit })
      .then(RelaySchema.parse);
    this.loggingService.info(
      `Sponsored relay ${relay.taskId} | chain ${args.chainId} | kind ${kind} | limited ${limitAddresses.join(',')} | gasLimit ${gasLimit}`,
    );
    return relay;
  }

  async getRelaysRemaining(args: {
    chainId: string;
    address: Address;
  }): Promise<{ remaining: number; limit: number }> {
    const config = await this.getSponsoredChain(args.chainId);
    if (!config) {
      return { remaining: 0, limit: 0 };
    }
    const spent = await this.cacheService.getCounter(
      GasTokenFeeService.dayKey('sponsored-spend', args.chainId),
    );
    if ((spent ?? 0) >= config.dailyBudgetGwei) {
      return { remaining: 0, limit: 0 };
    }
    const client = await this.blockchainApiManager.getApi(args.chainId);
    const code = await client.getCode({ address: args.address });
    const countKind = code && code !== '0x' ? 'safe' : 'creation';
    const limit =
      countKind === 'safe'
        ? config.perSafePerDay
        : config.perOwnerCreationsPerDay;
    const count =
      (await this.cacheService.getCounter(
        this.countKey(args.chainId, countKind, args.address),
      )) ?? 0;
    return { remaining: Math.max(limit - count, 0), limit };
  }

  private async getSponsoredChain(
    chainId: string,
  ): Promise<SponsoredChainConfiguration | null> {
    const config = this.sponsoredChains[chainId];
    if (!config) return null;
    const chain = await this.chainsRepository.getChain(chainId);
    return chain.features.includes(DailyLimitRelayer.FEATURE) ? config : null;
  }

  private countKey(
    chainId: string,
    countKind: 'creation' | 'safe',
    address: Address,
  ): string {
    // Kind keeps creation-owner counts off a Safe's quota; checksummed so POST and GET hit the same key
    return `sponsored-count:${chainId}:${countKind}:${getAddress(address)}:${new Date().toISOString().slice(0, 10)}`;
  }

  private getKind(data: Hex): 'exec' | 'multisend' | 'creation' | 'other' {
    if (this.safeDecoder.helpers.isExecTransaction(data)) return 'exec';
    if (this.multiSendDecoder.helpers.isMultiSend(data)) return 'multisend';
    if (this.proxyFactoryDecoder.helpers.isCreateProxyWithNonce(data))
      return 'creation';
    return 'other';
  }
}
