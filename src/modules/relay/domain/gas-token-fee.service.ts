import { Inject, Injectable } from '@nestjs/common';
import {
  BaseError,
  decodeAbiParameters,
  encodeFunctionData,
  hexToBigInt,
  isAddressEqual,
  isHex,
  parseAbi,
  size,
  slice,
  type Address,
  type Hex,
} from 'viem';
import { getSimulateTxAccessorDeployments } from '@/domain/common/utils/deployments';
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
  /** SimulateTxAccessor versions to look for, newest first; any of them works with a Safe ≥ 1.3.0 */
  private static readonly ACCESSOR_VERSIONS = ['1.4.1', '1.3.0'];
  /** `simulateAndRevert` measures the inner call once; the real one runs in a different state, so pad it */
  private static readonly SAFE_TX_GAS_MARGIN_BPS = BigInt(1_000);
  private static readonly SAFE_TX_GAS_MARGIN_FIXED = BigInt(10_000);
  private static readonly SAFE_ABI = parseAbi([
    'function simulateAndRevert(address targetContract, bytes calldataPayload)',
  ]);
  private static readonly ACCESSOR_ABI = parseAbi([
    'function simulate(address to, uint256 value, bytes data, uint8 operation) returns (uint256 estimate, bool success, bytes returnData)',
  ]);

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

    const [innerGas, market] = await Promise.all([
      this.estimateSafeTxGas(args),
      this.getMarket(args.chainId, token),
    ]);
    // With gasPrice > 0 the Safe gives the inner call exactly safeTxGas, so it must carry a margin
    const safeTxGas =
      innerGas +
      (innerGas * GasTokenFeeService.SAFE_TX_GAS_MARGIN_BPS) /
        GasTokenFeeService.BPS +
      GasTokenFeeService.SAFE_TX_GAS_MARGIN_FIXED;

    const baseGas =
      BigInt(this.configuration.baseGas) +
      BigInt(this.configuration.baseGasPerSignature) *
        BigInt(args.numberSignatures);
    const gasPrice = GasTokenFeeService.toTokenGasPrice(
      market,
      token.decimals,
      this.configuration.marginBps,
    );
    const nativeCostWei = (safeTxGas + baseGas) * market.gasPriceWei;

    return {
      txData: {
        chainId: args.chainId,
        safeAddress: args.safeAddress,
        safeTxGas: safeTxGas.toString(),
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
        priceSource: GasTokenFeeService.getPriceSource(
          this.configuration.nativeUsdPrices[args.chainId] !== undefined,
          token.usdPrice !== undefined,
        ),
        priceTimestamp: Math.floor(Date.now() / 1_000),
        gasPriceVolatilityBuffer:
          1 + this.configuration.marginBps / Number(GasTokenFeeService.BPS),
      },
    };
  }

  /**
   * Gas the inner call needs, measured on chain through the Safe's `simulateAndRevert` and the
   * official SimulateTxAccessor (CALL and DELEGATECALL, Safes ≥ 1.3.0). The transaction service's
   * estimate is not usable here: on L2 networks it answers 0 by design, harmless when the signer
   * pays but fatal when the Safe pays, because `execute` then gets exactly `safeTxGas` gas.
   * Falls back to the service when the Safe has no `simulateAndRevert`.
   * @throws GasTokenRelayError `SIMULATION_FAILED` when the inner call reverts
   */
  async estimateSafeTxGas(args: {
    chainId: string;
    safeAddress: Address;
    to: Address;
    value: string;
    data: Hex | null;
    operation: Operation;
  }): Promise<bigint> {
    const [accessor] = GasTokenFeeService.ACCESSOR_VERSIONS.flatMap((version) =>
      getSimulateTxAccessorDeployments({ chainId: args.chainId, version }),
    );
    if (!accessor) {
      return this.getServiceEstimate(args);
    }

    const client = await this.blockchainApiManager.getApi(args.chainId);
    const payload = encodeFunctionData({
      abi: GasTokenFeeService.ACCESSOR_ABI,
      functionName: 'simulate',
      args: [args.to, BigInt(args.value), args.data ?? '0x', args.operation],
    });
    const data = encodeFunctionData({
      abi: GasTokenFeeService.SAFE_ABI,
      functionName: 'simulateAndRevert',
      args: [accessor, payload],
    });
    const revertData = await client
      .request({
        method: 'eth_call',
        params: [{ to: args.safeAddress, data }, 'latest'],
      })
      .then(
        () => null,
        (error: unknown) => GasTokenFeeService.getRevertData(error),
      );
    const simulation = revertData
      ? GasTokenFeeService.decodeSimulation(revertData)
      : null;
    if (!simulation) {
      return this.getServiceEstimate(args);
    }
    if (!simulation.success) {
      throw new GasTokenRelayError(
        `Simulation failed: ${GasTokenFeeService.getRevertReason(simulation.returnData)}`,
        'SIMULATION_FAILED',
      );
    }
    return simulation.estimate;
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

  private static getPriceSource(
    fixedNative: boolean,
    fixedToken: boolean,
  ): string {
    if (fixedNative && fixedToken) {
      return 'fixed';
    }
    return fixedNative || fixedToken ? 'coingecko+fixed' : 'coingecko';
  }

  private async getServiceEstimate(args: {
    chainId: string;
    safeAddress: Address;
    to: Address;
    value: string;
    data: Hex | null;
    operation: Operation;
  }): Promise<bigint> {
    const estimation = await this.estimationsRepository.getEstimation({
      chainId: args.chainId,
      address: args.safeAddress,
      getEstimationDto: new GetEstimationDto(
        args.to,
        args.value,
        args.data,
        args.operation,
      ),
    });
    return BigInt(estimation.safeTxGas);
  }

  /** Revert payload of a JSON-RPC error, wherever the node or viem put it. */
  private static getRevertData(error: unknown): Hex | null {
    let current: unknown = error;
    for (let depth = 0; depth < 5 && current; depth++) {
      const { data, cause } = current as { data?: unknown; cause?: unknown };
      if (isHex(data)) {
        return data;
      }
      const nested = (data as { data?: unknown } | undefined)?.data;
      if (isHex(nested)) {
        return nested;
      }
      current = cause;
    }
    return null;
  }

  /**
   * `simulateAndRevert` reverts with `success (32) | responseSize (32) | response`, the response being
   * the accessor's `(uint256 estimate, bool success, bytes returnData)`. Null when the payload is not that.
   */
  private static decodeSimulation(
    revertData: Hex,
  ): { estimate: bigint; success: boolean; returnData: Hex } | null {
    if (size(revertData) < 64) {
      return null;
    }
    const accessorRan = hexToBigInt(slice(revertData, 0, 32)) !== BigInt(0);
    const responseSize = Number(hexToBigInt(slice(revertData, 32, 64)));
    if (!accessorRan || size(revertData) < 64 + responseSize) {
      return null;
    }
    try {
      const [estimate, success, returnData] = decodeAbiParameters(
        GasTokenFeeService.ACCESSOR_ABI[0].outputs,
        slice(revertData, 64, 64 + responseSize),
      );
      return { estimate, success, returnData };
    } catch {
      return null;
    }
  }

  private static getRevertReason(returnData: Hex): string {
    // Error(string)
    if (returnData.startsWith('0x08c379a0') && size(returnData) >= 68) {
      try {
        return decodeAbiParameters(
          [{ type: 'string' }],
          slice(returnData, 4),
        )[0];
      } catch {
        // fall through
      }
    }
    return returnData === '0x' ? 'call reverted' : returnData;
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
    const [gasPriceWei, nativeUsd, tokenUsd] = await Promise.all([
      client.getGasPrice(),
      this.configuration.nativeUsdPrices[chainId] ??
        this.getNativeUsdPrice(chain),
      token.usdPrice ?? this.getTokenUsdPrice(chain, token.address),
    ]);

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

  private async getNativeUsdPrice(chain: Chain): Promise<number | null> {
    const price = await this.pricesApi.getNativeCoinPrice({
      chain,
      fiatCode: GasTokenFeeService.FIAT_CODE,
    });
    return price?.[GasTokenFeeService.FIAT_CODE.toLowerCase()] ?? null;
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
