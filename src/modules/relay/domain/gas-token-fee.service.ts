import { Inject, Injectable } from '@nestjs/common';
import { BaseError, isAddressEqual, type Address, type Hex } from 'viem';
import { IConfigurationService } from '@/config/configuration.service.interface';
import { IChainsRepository } from '@/modules/chains/domain/chains.repository.interface';
import { IPricesApi } from '@/modules/balances/datasources/prices-api.interface';
import { getAssetPricesSchema } from '@/modules/balances/datasources/entities/asset-price.entity';
import { IBlockchainApiManager } from '@/domain/interfaces/blockchain-api.manager.interface';
import { IEstimationsRepository } from '@/modules/estimations/domain/estimations.repository.interface';
import { GetEstimationDto } from '@/modules/estimations/domain/entities/get-estimation.dto.entity';
import type { Chain } from '@/modules/chains/domain/entities/chain.entity';
import type { Operation } from '@/modules/safe/domain/entities/operation.entity';
import type {
  GasTokenAllowlistEntry,
  GasTokenConfiguration,
} from '@/modules/relay/domain/entities/gas-token.configuration';
import type { FeePreview } from '@/modules/relay/domain/entities/fee-preview.entity';
import { GasTokenRelayError } from '@/modules/relay/domain/errors/gas-token-relay.error';

/** Snapshot of what the relayer will pay and what the token is worth, prices scaled by PRICE_SCALE. */
type Market = {
  gasPriceWei: bigint;
  nativeUsd: bigint;
  tokenUsd: bigint;
};

/**
 * Prices "the Safe pays the relayer in a token" using the Safe contract's own refund:
 * `handlePayment` sends `(gasUsed + baseGas) × gasPrice` of `gasToken` to `refundReceiver`.
 * The preview turns the chain's native gas price into token units per gas, plus a margin.
 */
@Injectable()
export class GasTokenFeeService {
  private static readonly FIAT_CODE = 'USD';
  private static readonly PRICE_SCALE = BigInt(100_000_000);
  private static readonly BPS = BigInt(10_000);
  private static readonly WEI_PER_ETHER = BigInt(10) ** BigInt(18);
  /** Fee model version reported to the web app */
  private static readonly PRICING_PHASE = 2;
  /** Any account works: with a non-zero gasToken the Safe pays refundReceiver, not msg.sender. */
  private static readonly SIMULATION_SENDER: Address =
    '0x0000000000000000000000000000000000000001';

  private readonly configuration: GasTokenConfiguration;

  constructor(
    @Inject(IConfigurationService) configurationService: IConfigurationService,
    @Inject(IChainsRepository)
    private readonly chainsRepository: IChainsRepository,
    @Inject(IPricesApi) private readonly pricesApi: IPricesApi,
    @Inject(IBlockchainApiManager)
    private readonly blockchainApiManager: IBlockchainApiManager,
    @Inject(IEstimationsRepository)
    private readonly estimationsRepository: IEstimationsRepository,
  ) {
    this.configuration =
      configurationService.getOrThrow<GasTokenConfiguration>('relay.gasToken');
  }

  getRefundReceiver(chainId: string): Address | null {
    return this.configuration.refundReceivers[chainId] ?? null;
  }

  getAllowlistedToken(
    chainId: string,
    token: Address,
  ): GasTokenAllowlistEntry | null {
    const entries = this.configuration.allowlist[chainId] ?? [];
    return (
      entries.find((entry) => isAddressEqual(entry.address, token)) ?? null
    );
  }

  async preview(args: {
    chainId: string;
    safeAddress: Address;
    to: Address;
    value: string;
    data: Hex | null;
    operation: Operation;
    gasToken: Address;
    numberSignatures: number;
  }): Promise<FeePreview> {
    const refundReceiver = this.getRefundReceiver(args.chainId);
    if (!refundReceiver) {
      throw new GasTokenRelayError(
        `Paying fees from the Safe is not available on chain ${args.chainId}`,
      );
    }
    const token = this.getAllowlistedToken(args.chainId, args.gasToken);
    if (!token) {
      throw new GasTokenRelayError(
        `${args.gasToken} is not an accepted fee token on chain ${args.chainId}`,
      );
    }

    const [estimation, market] = await Promise.all([
      this.estimationsRepository.getEstimation({
        chainId: args.chainId,
        address: args.safeAddress,
        getEstimationDto: new GetEstimationDto(
          args.to,
          args.value,
          args.data,
          args.operation,
        ),
      }),
      this.getMarket(args.chainId, token),
    ]);

    const baseGas =
      BigInt(this.configuration.baseGas) +
      BigInt(this.configuration.baseGasPerSignature) *
        BigInt(args.numberSignatures);
    const gasPrice = GasTokenFeeService.toTokenGasPrice(
      market,
      token.decimals,
      this.configuration.marginBps,
    );
    const nativeCostWei =
      (BigInt(estimation.safeTxGas) + baseGas) * market.gasPriceWei;

    return {
      txData: {
        chainId: args.chainId,
        safeAddress: args.safeAddress,
        safeTxGas: estimation.safeTxGas,
        baseGas: baseGas.toString(),
        gasPrice: gasPrice.toString(),
        gasToken: token.address,
        refundReceiver,
        numberSignatures: args.numberSignatures,
      },
      relayCost: {
        fiatCode: GasTokenFeeService.FIAT_CODE,
        fiatValue: GasTokenFeeService.toUsd(
          nativeCostWei,
          18,
          market.nativeUsd,
        ),
      },
      pricingContextSnapshot: {
        phase: GasTokenFeeService.PRICING_PHASE,
        priceSource:
          token.usdPrice === undefined ? 'coingecko' : 'coingecko+fixed-token',
        priceTimestamp: Math.floor(Date.now() / 1_000),
        gasPriceVolatilityBuffer:
          1 + this.configuration.marginBps / Number(GasTokenFeeService.BPS),
      },
    };
  }

  /**
   * `eth_estimateGas` doubles as the pre-flight simulation: a failed token refund (GS012)
   * or any other revert surfaces here instead of costing the relayer a failed transaction.
   * @returns gas the execution needs
   */
  async simulate(args: {
    chainId: string;
    safeAddress: Address;
    data: Hex;
  }): Promise<bigint> {
    const client = await this.blockchainApiManager.getApi(args.chainId);
    try {
      return await client.estimateGas({
        account: GasTokenFeeService.SIMULATION_SENDER,
        to: args.safeAddress,
        data: args.data,
      });
    } catch (error) {
      throw new GasTokenRelayError(
        `Simulation failed: ${GasTokenFeeService.getReason(error)}`,
        'SIMULATION_FAILED',
      );
    }
  }

  /**
   * The fee was fixed when the transaction was proposed; gas may have moved since.
   * Refuses to relay when the token refund no longer covers today's native cost plus the minimum margin.
   */
  async assertRefundCovers(args: {
    chainId: string;
    token: GasTokenAllowlistEntry;
    gasPrice: bigint;
    baseGas: bigint;
    gasEstimate: bigint;
  }): Promise<void> {
    const market = await this.getMarket(args.chainId, args.token);
    const refund = (args.gasEstimate + args.baseGas) * args.gasPrice;
    const cost =
      (args.gasEstimate + BigInt(this.configuration.gasLimitBuffer)) *
      market.gasPriceWei;

    // refund × tokenUsd / 10^decimals  ≥  cost × nativeUsd / 10^18 × (1 + minMargin)
    const covered =
      refund *
      market.tokenUsd *
      GasTokenFeeService.WEI_PER_ETHER *
      GasTokenFeeService.BPS;
    const required =
      cost *
      market.nativeUsd *
      BigInt(10) ** BigInt(args.token.decimals) *
      (GasTokenFeeService.BPS + BigInt(this.configuration.minMarginBps));

    if (covered < required) {
      throw new GasTokenRelayError(
        'The fee signed into this transaction no longer covers the gas cost. Propose it again to refresh the fee.',
      );
    }
  }

  /** Token units per gas: gasWei × nativeUsd × 10^decimals × (1 + margin) / (tokenUsd × 10^18), rounded up. */
  static toTokenGasPrice(
    market: Market,
    decimals: number,
    marginBps: number,
  ): bigint {
    const numerator =
      market.gasPriceWei *
      market.nativeUsd *
      BigInt(10) ** BigInt(decimals) *
      (GasTokenFeeService.BPS + BigInt(marginBps));
    const denominator =
      market.tokenUsd *
      GasTokenFeeService.WEI_PER_ETHER *
      GasTokenFeeService.BPS;
    return (numerator + denominator - BigInt(1)) / denominator;
  }

  /** Amount of an asset in USD with up to six decimals, e.g. "8.5" or "0.001234". */
  static toUsd(amount: bigint, decimals: number, usdScaled: bigint): string {
    const micro =
      (amount * usdScaled * BigInt(1_000_000)) /
      (BigInt(10) ** BigInt(decimals) * GasTokenFeeService.PRICE_SCALE);
    return (Number(micro) / 1_000_000).toString();
  }

  private static getReason(error: unknown): string {
    if (error instanceof BaseError) {
      return error.shortMessage;
    }
    return error instanceof Error ? error.message : String(error);
  }

  private async getMarket(
    chainId: string,
    token: GasTokenAllowlistEntry,
  ): Promise<Market> {
    const [chain, client] = await Promise.all([
      this.chainsRepository.getChain(chainId),
      this.blockchainApiManager.getApi(chainId),
    ]);
    const [gasPriceWei, nativePrice, tokenUsd] = await Promise.all([
      client.getGasPrice(),
      this.pricesApi.getNativeCoinPrice({
        chain,
        fiatCode: GasTokenFeeService.FIAT_CODE,
      }),
      token.usdPrice ?? this.getTokenUsdPrice(chain, token.address),
    ]);
    const nativeUsd =
      nativePrice?.[GasTokenFeeService.FIAT_CODE.toLowerCase()] ?? null;

    if (nativeUsd === null || tokenUsd === null) {
      throw new GasTokenRelayError(
        'Price data is unavailable right now, try again later',
      );
    }

    return {
      gasPriceWei,
      nativeUsd: GasTokenFeeService.toScaled(nativeUsd),
      tokenUsd: GasTokenFeeService.toScaled(tokenUsd),
    };
  }

  private async getTokenUsdPrice(
    chain: Chain,
    address: Address,
  ): Promise<number | null> {
    const fiatCode = GasTokenFeeService.FIAT_CODE.toLowerCase();
    const raw = await this.pricesApi.getTokenPrices({
      chain,
      tokenAddresses: [address],
      fiatCode: GasTokenFeeService.FIAT_CODE,
    });
    for (const prices of getAssetPricesSchema(fiatCode).parse(raw)) {
      for (const [key, price] of Object.entries(prices)) {
        if (key.toLowerCase() === address.toLowerCase()) {
          return price[fiatCode] ?? null;
        }
      }
    }
    return null;
  }

  private static toScaled(price: number): bigint {
    return BigInt(Math.round(price * Number(GasTokenFeeService.PRICE_SCALE)));
  }
}
