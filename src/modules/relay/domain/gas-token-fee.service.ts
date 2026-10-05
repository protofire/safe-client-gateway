import { RelayNativePriceService } from '@/modules/relay/domain/relay-native-price.service';
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
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import { getSimulateTxAccessorDeployments } from '@/domain/common/utils/deployments';
import { IConfigurationService } from '@/config/configuration.service.interface';
import { IChainsRepository } from '@/modules/chains/domain/chains.repository.interface';
import { IPricesApi } from '@/modules/balances/datasources/prices-api.interface';
import { getAssetPricesSchema } from '@/modules/balances/datasources/entities/asset-price.entity';
import { IRelayApi } from '@/domain/interfaces/relay-api.interface';
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
import { CacheService } from '@/datasources/cache/cache.service.interface';
import type { ICacheService } from '@/datasources/cache/cache.service.interface';
import { LogType } from '@/domain/common/entities/log-type.entity';
import {
  LoggingService,
  type ILoggingService,
} from '@/logging/logging.interface';

/** Snapshot of what the relayer will pay and what the token is worth, prices scaled by PRICE_SCALE. */
type Market = {
  gasPriceWei: bigint;
  nativeUsd: bigint;
  tokenUsd: bigint;
  nativePriceTimestamp?: number;
};

/** A native refund is priced in wei; the USD price is for display only and may be missing. */
type NativeMarket = {
  gasPriceWei: bigint;
  nativeUsd: bigint | null;
  nativePriceTimestamp?: number;
};

/**
 * Prices "the Safe pays the relayer in a token" using the Safe contract's own refund:
 * `handlePayment` sends `(gasUsed + baseGas) × gasPrice` of `gasToken` to `refundReceiver`.
 * The preview turns the chain's native gas price into token units per gas, plus a margin.
 */
@Injectable()
export class GasTokenFeeService {
  static readonly FEATURE = 'PAY_FROM_SAFE';
  private static readonly FIAT_CODE = 'USD';
  private static readonly PRICE_SCALE = BigInt(100_000_000);
  private static readonly BPS = BigInt(10_000);
  private static readonly WEI_PER_ETHER = BigInt(10) ** BigInt(18);
  /** Fee model version reported to the web app */
  private static readonly PRICING_PHASE = 2;
  /** Any account works: the Safe pays refundReceiver, not msg.sender. */
  private static readonly SIMULATION_SENDER: Address =
    '0x0000000000000000000000000000000000000001';
  /** Simulation sender balance when simulating at a real gas price, enough for any gas limit */
  private static readonly SIMULATION_SENDER_BALANCE = BigInt(10) ** BigInt(30);
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
  // Legal memo V2: the fee must carry our margin, never a pure gas pass-through.
  // GasTokenFeeService is part of RelayModule, which every gateway instance
  // loads, so a misconfiguration must not crash the whole gateway (unlike a
  // component the app can run without). It fails closed instead: isEnabled()
  // returns false on every chain, in every environment, until minMarginBps is fixed.
  private readonly disabled: boolean;

  constructor(
    @Inject(IConfigurationService) configurationService: IConfigurationService,
    @Inject(IChainsRepository)
    private readonly chainsRepository: IChainsRepository,
    @Inject(IPricesApi) private readonly pricesApi: IPricesApi,
    @Inject(IBlockchainApiManager)
    private readonly blockchainApiManager: IBlockchainApiManager,
    @Inject(IEstimationsRepository)
    private readonly estimationsRepository: IEstimationsRepository,
    @Inject(CacheService) private readonly cacheService: ICacheService,
    private readonly nativePrices: RelayNativePriceService,
    @Inject(LoggingService) private readonly loggingService: ILoggingService,
    @Inject(IRelayApi) private readonly relayApi: IRelayApi,
  ) {
    this.configuration =
      configurationService.getOrThrow<GasTokenConfiguration>('relay.gasToken');
    let disabled = false;
    if (this.configuration.minMarginBps <= 0) {
      disabled = true;
      this.loggingService.error({
        type: LogType.GasTokenFeeMisconfigured,
        error: 'relay.gasToken.minMarginBps must be > 0; Safe-pays is disabled',
      });
    }
    this.disabled = disabled;
  }

  /** The zero address as gasToken: the Safe refunds in the chain's native coin. */
  static isNative(gasToken: Address): boolean {
    return isAddressEqual(gasToken, zeroAddress);
  }

  async getRefundReceiver(chainId: string): Promise<Address | null> {
    const relayChain = await this.chainsRepository.getRelayChain(chainId);
    return relayChain?.refundReceiver ?? null;
  }

  async isEnabled(chainId: string): Promise<boolean> {
    if (this.disabled) {
      return false;
    }
    const chain = await this.chainsRepository.getChain(chainId);
    if (!chain.features.includes(GasTokenFeeService.FEATURE)) {
      return false;
    }
    const relayChain = await this.chainsRepository.getRelayChain(chainId);
    if (!relayChain) {
      this.loggingService.error({
        type: LogType.GasTokenFeeMisconfigured,
        error: `${GasTokenFeeService.FEATURE} is on for chain ${chainId} without relay settings; Pay from Safe is off`,
      });
      return false;
    }
    // A budget is reserved at the relayer's gas price cap; without a cap it cannot be enforced
    if (
      relayChain.payFromSafeDailyBudgetWei !== null &&
      !(await this.relayApi.getGasPriceCap(chainId))
    ) {
      this.loggingService.error({
        type: LogType.GasTokenFeeMisconfigured,
        error: `${GasTokenFeeService.FEATURE} on chain ${chainId} has a daily budget but the relayer has no gas price cap; Pay from Safe is off`,
      });
      return false;
    }
    return true;
  }

  static dayKey(prefix: string, chainId: string): string {
    return `${prefix}:${chainId}:${new Date().toISOString().slice(0, 10)}`;
  }

  /**
   * Atomically reserves `ceil(outerGasLimit × maxGasPriceWei / 1e9)` gwei on `key`.
   * Never released: an ambiguous submission is not a certain failure.
   */
  async reserveGasBudget(args: {
    key: string;
    outerGasLimit: bigint;
    dailyLimitGwei: number;
    maxGasPriceWei: string;
  }): Promise<'reserved' | 'exceeded' | 'unavailable'> {
    const weiPerGwei = BigInt(1_000_000_000);
    const amountGwei =
      (args.outerGasLimit * BigInt(args.maxGasPriceWei) +
        weiPerGwei -
        BigInt(1)) /
      weiPerGwei;
    if (amountGwei > BigInt(Number.MAX_SAFE_INTEGER)) {
      return 'exceeded';
    }
    let reserved: number;
    try {
      reserved = await this.cacheService.increment(
        args.key,
        48 * 60 * 60,
        0,
        Number(amountGwei),
      );
    } catch {
      return 'unavailable';
    }
    return Number.isSafeInteger(reserved) && reserved <= args.dailyLimitGwei
      ? 'reserved'
      : 'exceeded';
  }

  async reserveNativeSpend(
    chainId: string,
    outerGasLimit: bigint,
  ): Promise<void> {
    if (!(await this.isEnabled(chainId))) {
      throw new GasTokenRelayError(
        `Paying fees from the Safe is not enabled on chain ${chainId}`,
      );
    }
    const relayChain = await this.chainsRepository.getRelayChain(chainId);
    const budgetWei = relayChain?.payFromSafeDailyBudgetWei ?? null;
    if (budgetWei === null) {
      return;
    }
    const maxGasPriceWei = await this.relayApi.getGasPriceCap(chainId);
    // isEnabled already required a cap; it can only vanish between the two reads
    if (!maxGasPriceWei) {
      throw new GasTokenRelayError('Unable to reserve Safe-pays gas budget');
    }
    const result = await this.reserveGasBudget({
      key: GasTokenFeeService.dayKey('gas-token-spend', chainId),
      outerGasLimit,
      dailyLimitGwei: GasTokenFeeService.toDailyLimitGwei(budgetWei),
      maxGasPriceWei: maxGasPriceWei.toString(),
    });
    if (result === 'unavailable') {
      throw new GasTokenRelayError('Unable to reserve Safe-pays gas budget');
    }
    if (result === 'exceeded') {
      throw new GasTokenRelayError('Safe-pays daily gas budget exceeded');
    }
  }

  /** A daily budget in wei as the gwei limit `reserveGasBudget` counts in, capped at the largest safe integer. */
  static toDailyLimitGwei(budgetWei: string): number {
    const gwei = BigInt(budgetWei) / BigInt(1_000_000_000);
    return gwei > BigInt(Number.MAX_SAFE_INTEGER)
      ? Number.MAX_SAFE_INTEGER
      : Number(gwei);
  }

  async getConfiguration(chainId: string): Promise<{
    gasTokens: Array<
      Pick<GasTokenAllowlistEntry, 'address' | 'symbol' | 'decimals'>
    >;
    refundReceiver: Address | null;
  }> {
    const relayChain = await this.chainsRepository.getRelayChain(chainId);
    return {
      gasTokens: (relayChain?.tokens ?? []).map(
        ({ address, symbol, decimals }) => ({ address, symbol, decimals }),
      ),
      refundReceiver: relayChain?.refundReceiver ?? null,
    };
  }

  async getAllowlistedToken(
    chainId: string,
    token: Address,
  ): Promise<GasTokenAllowlistEntry | null> {
    const relayChain = await this.chainsRepository.getRelayChain(chainId);
    return (
      relayChain?.tokens.find((entry) =>
        isAddressEqual(entry.address, token),
      ) ?? null
    );
  }

  /** Fixed native USD price from the relay settings (testnets without a feed), else null. */
  private async getFixedNativeUsd(chainId: string): Promise<number | null> {
    const relayChain = await this.chainsRepository.getRelayChain(chainId);
    return relayChain?.nativeUsdPrice ?? null;
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
    if (!(await this.isEnabled(args.chainId))) {
      throw new GasTokenRelayError(
        `Paying fees from the Safe is not enabled on chain ${args.chainId}`,
      );
    }
    const refundReceiver = await this.getRefundReceiver(args.chainId);
    if (!refundReceiver) {
      throw new GasTokenRelayError(
        `Paying fees from the Safe is not available on chain ${args.chainId}`,
      );
    }
    const token = await this.getAllowlistedToken(args.chainId, args.gasToken);
    if (!token) {
      throw new GasTokenRelayError(
        `${args.gasToken} is not an accepted fee token on chain ${args.chainId}`,
      );
    }

    const fixedNativeUsd = await this.getFixedNativeUsd(args.chainId);
    const [innerGas, market] = await Promise.all([
      this.estimateSafeTxGas(args),
      GasTokenFeeService.isNative(token.address)
        ? this.getNativeMarket(args.chainId, fixedNativeUsd)
        : this.getMarket(args.chainId, token, fixedNativeUsd),
    ]);
    // With gasPrice > 0 the Safe gives the inner call exactly safeTxGas, so it must carry a margin
    const safeTxGas =
      innerGas +
      (innerGas * GasTokenFeeService.SAFE_TX_GAS_MARGIN_BPS) /
        GasTokenFeeService.BPS +
      GasTokenFeeService.SAFE_TX_GAS_MARGIN_FIXED;

    const configuredBaseGas =
      BigInt(this.configuration.baseGas) +
      BigInt(this.configuration.baseGasPerSignature) *
        BigInt(args.numberSignatures);
    // Quote the outer gas budget, but collect it through the Safe's inner-gas refund.
    // The signed execution is still simulated and checked against its actual estimate.
    const outerGasBudget =
      safeTxGas + configuredBaseGas + BigInt(this.configuration.gasLimitBuffer);
    if (innerGas + configuredBaseGas === BigInt(0)) {
      throw new GasTokenRelayError(
        'Cannot quote a transaction with zero refundable gas',
      );
    }
    let baseGas = configuredBaseGas;
    let gasPrice: bigint;
    if (GasTokenFeeService.isNative(token.address)) {
      // handlePayment refunds native at min(gasPrice, tx.gasprice): a margin in gasPrice never
      // arrives. Sign gasPrice as a ceiling with headroom and carry the margin in baseGas instead.
      const marginFactor =
        GasTokenFeeService.BPS + BigInt(this.configuration.marginBps);
      gasPrice = GasTokenFeeService.ceilDiv(
        market.gasPriceWei * marginFactor,
        GasTokenFeeService.BPS,
      );
      const refundGas = GasTokenFeeService.ceilDiv(
        outerGasBudget * marginFactor,
        GasTokenFeeService.BPS,
      );
      if (refundGas - innerGas > baseGas) {
        baseGas = refundGas - innerGas;
      }
    } else {
      gasPrice = GasTokenFeeService.toTokenGasPrice(
        // A non-native token always gets the fully priced market from getMarket
        market as Market,
        token.decimals,
        this.configuration.marginBps,
        outerGasBudget,
        innerGas + baseGas,
      );
    }
    const nativeCostWei = outerGasBudget * market.gasPriceWei;

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
        fiatValue:
          market.nativeUsd === null
            ? null
            : GasTokenFeeService.toUsd(nativeCostWei, 18, market.nativeUsd),
      },
      pricingContextSnapshot: {
        phase: GasTokenFeeService.PRICING_PHASE,
        priceSource:
          market.nativeUsd === null
            ? 'unavailable'
            : GasTokenFeeService.getPriceSource(
                fixedNativeUsd !== null,
                GasTokenFeeService.isNative(token.address)
                  ? fixedNativeUsd !== null
                  : token.usdPrice !== undefined,
              ),
        priceTimestamp: Math.floor(
          (market.nativePriceTimestamp ?? Date.now()) / 1_000,
        ),
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
   * Without `gasPrice` it runs at tx.gasprice 0, which makes a native refund 0; pass the signed
   * gasPrice for a native gasToken so the refund's send() (GS011) runs too. The sender is funded
   * by a state override to afford that price.
   * @returns gas the execution needs
   */
  async simulate(args: {
    chainId: string;
    safeAddress: Address;
    data: Hex;
    gasPrice?: bigint;
    /** `false` for targets that are not a Safe `execTransaction` (no `bool` result). */
    checkSafeResult?: boolean;
  }): Promise<bigint> {
    const client = await this.blockchainApiManager.getApi(args.chainId);
    const request = {
      account: GasTokenFeeService.SIMULATION_SENDER,
      to: args.safeAddress,
      data: args.data,
      ...(args.gasPrice !== undefined && {
        gasPrice: args.gasPrice,
        stateOverride: [
          {
            address: GasTokenFeeService.SIMULATION_SENDER,
            balance: GasTokenFeeService.SIMULATION_SENDER_BALANCE,
          },
        ],
      }),
    };
    try {
      const estimate = await client.estimateGas(request);
      if (args.checkSafeResult ?? true) {
        const call = await client.call(request);
        if (!call.data) throw new Error('Missing execution result');
        const [success] = decodeAbiParameters([{ type: 'bool' }], call.data);
        if (!success) throw new Error('Safe execution returned false');
      }
      return estimate;
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
    innerGasEstimate: bigint;
    outerGasLimit: bigint;
  }): Promise<void> {
    const fixedNativeUsd = await this.getFixedNativeUsd(args.chainId);
    if (GasTokenFeeService.isNative(args.token.address)) {
      const { gasPriceWei } = await this.getNativeMarket(
        args.chainId,
        fixedNativeUsd,
      );
      return this.assertNativeRefundCovers(args, gasPriceWei);
    }
    const market = await this.getMarket(
      args.chainId,
      args.token,
      fixedNativeUsd,
    );
    const refund = (args.innerGasEstimate + args.baseGas) * args.gasPrice;
    const cost = args.outerGasLimit * market.gasPriceWei;

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

  /**
   * Native refund is `(gasUsed + baseGas) × min(gasPrice, tx.gasprice)` (handlePayment), so the
   * signed gasPrice needs headroom over today's price and the margin has to come from the gas units.
   */
  private assertNativeRefundCovers(
    args: {
      gasPrice: bigint;
      baseGas: bigint;
      innerGasEstimate: bigint;
      outerGasLimit: bigint;
    },
    currentGasPrice: bigint,
  ): void {
    // Headroom for the relayer's price: 'fast' speed and replacement bumps land above today's price
    if (
      args.gasPrice * GasTokenFeeService.BPS <
      currentGasPrice *
        (GasTokenFeeService.BPS + BigInt(this.configuration.minMarginBps))
    ) {
      throw new GasTokenRelayError(
        'The gas price signed into this transaction is below the current network gas price, so the refund would not cover the gas cost. Propose it again to refresh the fee.',
      );
    }
    // The refund is paid at min(gasPrice, tx.gasprice), i.e. at most the current price
    const covered =
      (args.innerGasEstimate + args.baseGas) *
      currentGasPrice *
      GasTokenFeeService.BPS;
    const required =
      args.outerGasLimit *
      currentGasPrice *
      (GasTokenFeeService.BPS + BigInt(this.configuration.minMarginBps));
    if (covered < required) {
      throw new GasTokenRelayError(
        'The fee signed into this transaction no longer covers the gas cost. Propose it again to refresh the fee.',
      );
    }
  }

  private static ceilDiv(numerator: bigint, denominator: bigint): bigint {
    return (numerator + denominator - BigInt(1)) / denominator;
  }

  /** Token units per gas: gasWei × nativeUsd × 10^decimals × (1 + margin) / (tokenUsd × 10^18), rounded up. */
  static toTokenGasPrice(
    market: Market,
    decimals: number,
    marginBps: number,
    outerGasBudget = BigInt(1),
    refundGas = BigInt(1),
  ): bigint {
    const numerator =
      market.gasPriceWei *
      market.nativeUsd *
      BigInt(10) ** BigInt(decimals) *
      (GasTokenFeeService.BPS + BigInt(marginBps)) *
      outerGasBudget;
    const denominator =
      market.tokenUsd *
      GasTokenFeeService.WEI_PER_ETHER *
      GasTokenFeeService.BPS *
      refundGas;
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
    fixedNativeUsd: number | null,
  ): Promise<Market> {
    const [chain, client] = await Promise.all([
      this.chainsRepository.getChain(chainId),
      this.blockchainApiManager.getApi(chainId),
    ]);
    const [gasPriceWei, nativePrice, tokenUsd] = await Promise.all([
      client.getGasPrice(),
      this.getNativeUsdPrice(chain, fixedNativeUsd),
      token.usdPrice ?? this.getTokenUsdPrice(chain, token.address),
    ]);

    const nativeUsd = nativePrice?.usd ?? null;
    if (
      nativeUsd === null ||
      tokenUsd === null ||
      !Number.isFinite(nativeUsd) ||
      nativeUsd <= 0 ||
      !Number.isFinite(tokenUsd) ||
      tokenUsd <= 0
    ) {
      throw new GasTokenRelayError(
        'Price data is unavailable right now, try again later',
      );
    }

    return {
      gasPriceWei,
      nativePriceTimestamp: nativePrice?.fetchedAt,
      nativeUsd: GasTokenFeeService.toScaled(nativeUsd),
      tokenUsd: GasTokenFeeService.toScaled(tokenUsd),
    };
  }

  private async getNativeMarket(
    chainId: string,
    fixedNativeUsd: number | null,
  ): Promise<NativeMarket> {
    const [chain, client] = await Promise.all([
      this.chainsRepository.getChain(chainId),
      this.blockchainApiManager.getApi(chainId),
    ]);
    const [gasPriceWei, nativePrice] = await Promise.all([
      client.getGasPrice(),
      this.getNativeUsdPrice(chain, fixedNativeUsd),
    ]);
    const usd = nativePrice?.usd;
    const priced = usd !== undefined && Number.isFinite(usd) && usd > 0;
    return {
      gasPriceWei,
      nativeUsd: priced ? GasTokenFeeService.toScaled(usd) : null,
      nativePriceTimestamp: priced ? nativePrice?.fetchedAt : undefined,
    };
  }

  private getNativeUsdPrice(
    chain: Chain,
    fixedNativeUsd: number | null,
  ): Promise<{ usd: number; fetchedAt: number } | null> {
    return fixedNativeUsd !== null
      ? Promise.resolve({ usd: fixedNativeUsd, fetchedAt: Date.now() })
      : this.nativePrices.getPrice(chain);
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
