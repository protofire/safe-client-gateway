import type { RelayNativePriceService } from '@/modules/relay/domain/relay-native-price.service';
import { faker } from '@faker-js/faker';
import {
  concatHex,
  encodeAbiParameters,
  getAddress,
  numberToHex,
  parseGwei,
  size,
  zeroAddress,
} from 'viem';
import type { Address, PublicClient } from 'viem';
import { FakeConfigurationService } from '@/config/__tests__/fake.configuration.service';
import type { IBlockchainApiManager } from '@/domain/interfaces/blockchain-api.manager.interface';
import type { IPricesApi } from '@/modules/balances/datasources/prices-api.interface';
import { chainBuilder } from '@/modules/chains/domain/entities/__tests__/chain.builder';
import type { IChainsRepository } from '@/modules/chains/domain/chains.repository.interface';
import type { IEstimationsRepository } from '@/modules/estimations/domain/estimations.repository.interface';
import type { ICacheService } from '@/datasources/cache/cache.service.interface';
import type { ILoggingService } from '@/logging/logging.interface';
import { GasTokenFeeService } from '@/modules/relay/domain/gas-token-fee.service';
import { GasTokenRelayError } from '@/modules/relay/domain/errors/gas-token-relay.error';
import type { GasTokenConfiguration } from '@/modules/relay/domain/entities/gas-token.configuration';
import {
  RelayChainSchema,
  type RelayChain,
} from '@/modules/relay/domain/entities/gas-token.configuration';
import { relayChainBuilder } from '@/modules/relay/domain/entities/__tests__/relay-chain.builder';
import relayChainContract from '@/modules/relay/domain/entities/__tests__/relay-chain-84532.contract.json';
import type { IRelayApi } from '@/domain/interfaces/relay-api.interface';
import { Operation } from '@/modules/safe/domain/entities/operation.entity';
import { rawify } from '@/validation/entities/raw.entity';

const mockChainsRepository = jest.mocked({
  getChain: jest.fn(),
  getRelayChain: jest.fn(),
} as jest.MockedObjectDeep<IChainsRepository>);

const mockRelayApi = jest.mocked({
  getGasPriceCap: jest.fn(),
} as jest.MockedObjectDeep<IRelayApi>);

const mockNativePrices = {
  getPrice: jest.fn(),
} as unknown as jest.Mocked<RelayNativePriceService>;

const mockPricesApi = jest.mocked({
  getNativeCoinPrice: jest.fn(),
  getTokenPrices: jest.fn(),
} as jest.MockedObjectDeep<IPricesApi>);

const mockPublicClient = jest.mocked({
  getGasPrice: jest.fn(),
  estimateGas: jest.fn(),
  call: jest.fn(),
  request: jest.fn(),
} as jest.MockedObjectDeep<PublicClient>);

/** What `simulateAndRevert` reverts with: success | responseSize | accessor (estimate, success, returnData) */
function simulateAndRevertData(args: {
  estimate: bigint;
  success: boolean;
  returnData?: `0x${string}`;
}): `0x${string}` {
  const response = encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'bool' }, { type: 'bytes' }],
    [args.estimate, args.success, args.returnData ?? '0x'],
  );
  return concatHex([
    numberToHex(1, { size: 32 }),
    numberToHex(size(response), { size: 32 }),
    response,
  ]);
}

function mockSimulation(args: {
  estimate: bigint;
  success: boolean;
  returnData?: `0x${string}`;
}): void {
  mockPublicClient.request.mockRejectedValue(
    Object.assign(new Error('execution reverted'), {
      data: simulateAndRevertData(args),
    }),
  );
}

const mockBlockchainApiManager = jest.mocked({
  getApi: jest.fn(),
} as jest.MockedObjectDeep<IBlockchainApiManager>);

const mockEstimationsRepository = jest.mocked({
  getEstimation: jest.fn(),
} as jest.MockedObjectDeep<IEstimationsRepository>);
const mockCacheService = jest.mocked({
  increment: jest.fn(),
} as jest.MockedObjectDeep<ICacheService>);

const mockLoggingService = jest.mocked({
  error: jest.fn(),
} as jest.MockedObjectDeep<ILoggingService>);

function buildService(
  config: FakeConfigurationService,
  loggingService: jest.MockedObjectDeep<ILoggingService> = mockLoggingService,
): GasTokenFeeService {
  return new GasTokenFeeService(
    config,
    mockChainsRepository,
    mockPricesApi,
    mockBlockchainApiManager,
    mockEstimationsRepository,
    mockCacheService,
    mockNativePrices,
    loggingService,
    mockRelayApi,
  );
}

describe('GasTokenFeeService', () => {
  const chainId = '11155111';
  const chain = chainBuilder()
    .with('chainId', chainId)
    .with('features', [GasTokenFeeService.FEATURE])
    .build();
  const refundReceiver = getAddress(faker.finance.ethereumAddress());
  const usdc = getAddress(faker.finance.ethereumAddress());
  const configuration: GasTokenConfiguration = {
    marginBps: 2_000,
    minMarginBps: 500,
    baseGas: 70_000,
    baseGasPerSignature: 1_500,
    gasLimitBuffer: 50_000,
  };
  const relayChain: RelayChain = relayChainBuilder()
    .with('refundReceiver', refundReceiver)
    .with('nativeUsdPrice', null)
    // 10,000,000 gwei; reservations price gas at the relayer cap below (30 gwei)
    .with('payFromSafeDailyBudgetWei', '10000000000000000')
    .with('tokens', [
      { address: usdc, symbol: 'USDC', decimals: 6, usdPrice: 1 },
    ])
    .build();
  // 20 gwei gas, ETH at $2,500, USDC at $1
  const market = {
    gasPriceWei: parseGwei('20'),
    nativeUsd: BigInt(2_500) * BigInt(100_000_000),
    tokenUsd: BigInt(1) * BigInt(100_000_000),
  };
  let target: GasTokenFeeService;

  beforeEach(() => {
    jest.resetAllMocks();
    const fakeConfigurationService = new FakeConfigurationService();
    fakeConfigurationService.set('relay.gasToken', configuration);
    mockChainsRepository.getChain.mockResolvedValue(chain);
    mockChainsRepository.getRelayChain.mockResolvedValue(relayChain);
    mockRelayApi.getGasPriceCap.mockResolvedValue(parseGwei('30'));
    mockBlockchainApiManager.getApi.mockResolvedValue(mockPublicClient);
    mockPublicClient.getGasPrice.mockResolvedValue(parseGwei('20'));
    mockPublicClient.call.mockResolvedValue({
      data: encodeAbiParameters([{ type: 'bool' }], [true]),
    });
    mockNativePrices.getPrice.mockResolvedValue({
      usd: 2_500,
      fetchedAt: Date.now(),
    });

    target = buildService(fakeConfigurationService);
  });

  describe('toTokenGasPrice', () => {
    it('should convert the native gas price into token units per gas with margin', () => {
      // 20 gwei × $2,500 = $0.00005 per gas, +20 % = 60 micro-USDC
      expect(GasTokenFeeService.toTokenGasPrice(market, 6, 2_000)).toBe(
        BigInt(60),
      );
    });

    it('should round up', () => {
      // 1 wei of gas cannot buy 0 tokens
      expect(
        GasTokenFeeService.toTokenGasPrice(
          { ...market, gasPriceWei: BigInt(1) },
          6,
          0,
        ),
      ).toBe(BigInt(1));
    });
  });

  describe('preview', () => {
    it('should refuse a chain without the PAY_FROM_SAFE feature', async () => {
      mockChainsRepository.getChain.mockResolvedValue(
        chainBuilder().with('chainId', chainId).with('features', []).build(),
      );

      await expect(
        target.preview({
          chainId,
          safeAddress: getAddress(faker.finance.ethereumAddress()),
          to: getAddress(faker.finance.ethereumAddress()),
          value: '0',
          data: '0x',
          operation: Operation.CALL,
          gasToken: usdc,
          numberSignatures: 1,
        }),
      ).rejects.toThrow('not enabled on chain');
      expect(mockBlockchainApiManager.getApi).not.toHaveBeenCalled();
    });

    it.each([undefined, '', '   '])(
      'rejects a missing or blank token symbol: %s',
      (symbol) => {
        expect(() =>
          RelayChainSchema.parse({
            ...relayChainContract,
            tokens: [{ ...relayChainContract.tokens[0], symbol }],
          }),
        ).toThrow();
      },
    );

    it('should expose enabled token configuration', async () => {
      await expect(target.getConfiguration(chainId)).resolves.toStrictEqual({
        gasTokens: [{ address: usdc, symbol: 'USDC', decimals: 6 }],
        refundReceiver,
      });
    });

    it('should return the fee fields for an allowlisted token', async () => {
      mockSimulation({ estimate: BigInt(100_000), success: true });
      const to = getAddress(faker.finance.ethereumAddress());

      const result = await target.preview({
        chainId,
        safeAddress: getAddress(faker.finance.ethereumAddress()),
        to,
        value: '0',
        data: '0x',
        operation: Operation.CALL,
        gasToken: usdc.toLowerCase() as Address,
        numberSignatures: 2,
      });

      expect(result).toStrictEqual({
        txData: {
          chainId,
          safeAddress: result.txData.safeAddress,
          // 100k measured + 10 % + 10k
          safeTxGas: '120000',
          // 70k + 2 × 1.5k
          baseGas: '73000',
          gasPrice: '85',
          gasToken: usdc,
          refundReceiver,
          numberSignatures: 2,
        },
        // (120k + 73k + 50k limit buffer) × 20 gwei × $2,500
        relayCost: { fiatCode: 'USD', fiatValue: '12.15' },
        pricingContextSnapshot: {
          phase: 2,
          priceSource: 'coingecko+fixed',
          priceTimestamp: expect.any(Number),
          gasPriceVolatilityBuffer: 1.2,
        },
      });
      expect(mockPricesApi.getTokenPrices).not.toHaveBeenCalled();
      expect(mockEstimationsRepository.getEstimation).not.toHaveBeenCalled();
    });

    it('should fail with SIMULATION_FAILED when the inner call reverts', async () => {
      mockSimulation({
        estimate: BigInt(0),
        success: false,
        // Error("GS013")
        returnData: `0x08c379a0${encodeAbiParameters([{ type: 'string' }], ['GS013']).slice(2)}`,
      });

      const error: unknown = await target
        .preview({
          chainId,
          safeAddress: getAddress(faker.finance.ethereumAddress()),
          to: getAddress(faker.finance.ethereumAddress()),
          value: '0',
          data: '0x',
          operation: Operation.CALL,
          gasToken: usdc,
          numberSignatures: 1,
        })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(GasTokenRelayError);
      expect((error as GasTokenRelayError).getResponse()).toMatchObject({
        code: 'SIMULATION_FAILED',
        message: 'Simulation failed: GS013',
      });
    });

    it('should fall back to the transaction service when the Safe cannot simulate', async () => {
      // an old Safe: the call returns instead of reverting
      mockPublicClient.request.mockResolvedValue('0x');
      mockEstimationsRepository.getEstimation.mockResolvedValue({
        safeTxGas: '50000',
      });

      const result = await target.preview({
        chainId,
        safeAddress: getAddress(faker.finance.ethereumAddress()),
        to: getAddress(faker.finance.ethereumAddress()),
        value: '0',
        data: '0x',
        operation: Operation.CALL,
        gasToken: usdc,
        numberSignatures: 1,
      });

      // 50k + 10 % + 10k
      expect(result.txData.safeTxGas).toBe('65000');
    });

    it('should price the token from the market when no fixed price is configured', async () => {
      const dai = getAddress(faker.finance.ethereumAddress());
      mockChainsRepository.getRelayChain.mockResolvedValue({
        ...relayChain,
        tokens: [
          { address: dai, symbol: 'DAI', decimals: 18, usdPrice: undefined },
        ],
      });
      mockSimulation({ estimate: BigInt(0), success: true });
      mockPricesApi.getTokenPrices.mockResolvedValue(
        rawify([{ [dai.toLowerCase()]: { usd: 0.5, usd_24h_change: null } }]),
      );

      const result = await target.preview({
        chainId,
        safeAddress: getAddress(faker.finance.ethereumAddress()),
        to: getAddress(faker.finance.ethereumAddress()),
        value: '0',
        data: null,
        operation: Operation.CALL,
        gasToken: dai,
        numberSignatures: 1,
      });

      // $0.00006 per gas at $0.5 per token = 0.00012 tokens = 1.2e14 wei-units
      expect(result.txData.gasPrice).toBe('220699300699301');
    });

    it('should use a fixed native price when configured', async () => {
      mockChainsRepository.getRelayChain.mockResolvedValue({
        ...relayChain,
        nativeUsdPrice: 5_000,
      });
      mockSimulation({ estimate: BigInt(0), success: true });

      const result = await target.preview({
        chainId,
        safeAddress: getAddress(faker.finance.ethereumAddress()),
        to: getAddress(faker.finance.ethereumAddress()),
        value: '0',
        data: '0x',
        operation: Operation.CALL,
        gasToken: usdc,
        numberSignatures: 1,
      });

      // twice the market price of ETH → twice the token gas price
      expect(result.txData.gasPrice).toBe('221');
      expect(result.pricingContextSnapshot.priceSource).toBe('fixed');
      expect(mockNativePrices.getPrice).not.toHaveBeenCalled();
    });

    it('should refuse a token that is not allowlisted', async () => {
      await expect(
        target.preview({
          chainId,
          safeAddress: getAddress(faker.finance.ethereumAddress()),
          to: getAddress(faker.finance.ethereumAddress()),
          value: '0',
          data: '0x',
          operation: Operation.CALL,
          gasToken: getAddress(faker.finance.ethereumAddress()),
          numberSignatures: 1,
        }),
      ).rejects.toThrow(GasTokenRelayError);
    });

    it('should refuse a chain without a refund receiver', async () => {
      mockChainsRepository.getRelayChain.mockResolvedValue({
        ...relayChain,
        refundReceiver: null,
      });
      await expect(
        target.preview({
          chainId: '1',
          safeAddress: getAddress(faker.finance.ethereumAddress()),
          to: getAddress(faker.finance.ethereumAddress()),
          value: '0',
          data: '0x',
          operation: Operation.CALL,
          gasToken: usdc,
          numberSignatures: 1,
        }),
      ).rejects.toThrow('not available on chain 1');
    });

    it('should fail when the native price is unavailable', async () => {
      mockNativePrices.getPrice.mockResolvedValue(null);
      mockSimulation({ estimate: BigInt(0), success: true });

      await expect(
        target.preview({
          chainId,
          safeAddress: getAddress(faker.finance.ethereumAddress()),
          to: getAddress(faker.finance.ethereumAddress()),
          value: '0',
          data: '0x',
          operation: Operation.CALL,
          gasToken: usdc,
          numberSignatures: 1,
        }),
      ).rejects.toThrow('Price data is unavailable');
    });
  });

  describe('quote to execution regression', () => {
    it.each([6, 18])(
      'covers the Base transfer with %i token decimals and rejects a gas spike',
      async (decimals) => {
        const token = { address: usdc, symbol: 'USD', decimals, usdPrice: 1 };
        mockChainsRepository.getRelayChain.mockResolvedValue({
          ...relayChain,
          tokens: [token],
        });
        const service = target;
        mockSimulation({ estimate: BigInt(43_546), success: true });
        mockPublicClient.getGasPrice.mockResolvedValue(BigInt(6_000_000));
        const preview = await service.preview({
          chainId,
          safeAddress: usdc,
          to: usdc,
          value: '0',
          data: '0x',
          operation: Operation.CALL,
          gasToken: usdc,
          numberSignatures: 1,
        });
        const execution = {
          chainId,
          token,
          gasPrice: BigInt(preview.txData.gasPrice),
          baseGas: BigInt(preview.txData.baseGas),
          innerGasEstimate: BigInt(43_546),
          outerGasLimit: BigInt(143_964 + 50_000),
        };
        await expect(
          service.assertRefundCovers(execution),
        ).resolves.toBeUndefined();
        mockPublicClient.getGasPrice.mockResolvedValue(parseGwei('20'));
        await expect(service.assertRefundCovers(execution)).rejects.toThrow(
          'no longer covers',
        );
      },
    );
  });

  describe('assertRefundCovers', () => {
    const token = relayChain.tokens[0];
    // refund = (50k + 70k) × 60 = 7.2 USDC; cost = 120k × 20 gwei = 0.0024 ETH = $6, +5 % = $6.30
    const args = {
      chainId,
      token,
      gasPrice: BigInt(60),
      baseGas: BigInt(70_000),
      innerGasEstimate: BigInt(50_000),
      outerGasLimit: BigInt(120_000),
    };

    it('should pass when the signed refund still covers gas plus the minimum margin', async () => {
      await expect(target.assertRefundCovers(args)).resolves.toBeUndefined();
    });

    it('should refuse when gas has risen past the refund', async () => {
      // $12 + 5 % = $12.60 > $7.20
      mockPublicClient.getGasPrice.mockResolvedValue(parseGwei('30'));

      await expect(target.assertRefundCovers(args)).rejects.toThrow(
        'no longer covers the gas cost',
      );
    });

    it('should reject when an inflated outer estimate would hide an underfunded inner refund', async () => {
      await expect(
        target.assertRefundCovers({
          ...args,
          innerGasEstimate: BigInt(50_000),
          outerGasLimit: BigInt(200_000),
        }),
      ).rejects.toThrow('no longer covers the gas cost');
    });
  });

  describe('native gas token', () => {
    const native = {
      address: zeroAddress,
      symbol: 'USDC',
      decimals: 18,
      usdPrice: undefined,
    };
    const nativeRelayChain: RelayChain = {
      ...relayChain,
      nativeUsdPrice: 1,
      tokens: [native],
    };
    let service: GasTokenFeeService;

    beforeEach(() => {
      mockChainsRepository.getRelayChain.mockResolvedValue(nativeRelayChain);
      service = target;
    });

    const nativeContract = {
      ...relayChainContract,
      tokens: [
        { address: zeroAddress, symbol: 'USDC', decimals: 18, usdPrice: null },
      ],
    };

    it('accepts the zero address as a fee token', () => {
      expect(() => RelayChainSchema.parse(nativeContract)).not.toThrow();
    });

    it('still rejects a duplicate native entry', () => {
      expect(() =>
        RelayChainSchema.parse({
          ...nativeContract,
          tokens: [...nativeContract.tokens, ...nativeContract.tokens],
        }),
      ).toThrow('duplicate token address');
    });

    it('still rejects the zero address as a refund receiver', () => {
      expect(() =>
        RelayChainSchema.parse({
          ...nativeContract,
          refundReceiver: zeroAddress,
        }),
      ).toThrow('must be non-zero');
    });

    it('signs a gas price ceiling above market and puts the margin in baseGas', async () => {
      mockSimulation({ estimate: BigInt(100_000), success: true });

      const result = await service.preview({
        chainId,
        safeAddress: getAddress(faker.finance.ethereumAddress()),
        to: getAddress(faker.finance.ethereumAddress()),
        value: '0',
        data: '0x',
        operation: Operation.CALL,
        gasToken: zeroAddress,
        numberSignatures: 2,
      });

      expect(result.txData).toStrictEqual({
        chainId,
        safeAddress: result.txData.safeAddress,
        safeTxGas: '120000',
        // outer budget (120k + 73k + 50k) × 1.2 − 100k inner
        baseGas: '191600',
        // 20 gwei × 1.2
        gasPrice: parseGwei('24').toString(),
        gasToken: zeroAddress,
        refundReceiver,
        numberSignatures: 2,
      });
      // 243k × 20 gwei × $1
      expect(result.relayCost).toStrictEqual({
        fiatCode: 'USD',
        fiatValue: '0.00486',
      });
      expect(result.pricingContextSnapshot.priceSource).toBe('fixed');
      const refundGas = BigInt(100_000) + BigInt(result.txData.baseGas);
      expect(refundGas * BigInt(10_000)).toBeGreaterThanOrEqual(
        BigInt(243_000) * BigInt(12_000),
      );
      expect(BigInt(result.txData.gasPrice)).toBeGreaterThanOrEqual(
        parseGwei('20'),
      );
      expect(mockPricesApi.getTokenPrices).not.toHaveBeenCalled();
    });

    it('makes inner + baseGas equal the outer budget with a zero margin', async () => {
      const config = new FakeConfigurationService();
      config.set('relay.gasToken', {
        ...configuration,
        marginBps: 0,
        gasLimitBuffer: 0,
      });
      service = buildService(config);
      mockSimulation({ estimate: BigInt(100_000), success: true });

      const result = await service.preview({
        chainId,
        safeAddress: getAddress(faker.finance.ethereumAddress()),
        to: getAddress(faker.finance.ethereumAddress()),
        value: '0',
        data: '0x',
        operation: Operation.CALL,
        gasToken: zeroAddress,
        numberSignatures: 1,
      });

      // outer 120k + 71.5k = 191.5k, − 100k inner
      expect(result.txData.baseGas).toBe('91500');
      expect(result.txData.gasPrice).toBe(parseGwei('20').toString());
    });

    it('prices the native coin as the token without asking the prices API', async () => {
      mockChainsRepository.getRelayChain.mockResolvedValue({
        ...nativeRelayChain,
        nativeUsdPrice: null,
      });
      mockSimulation({ estimate: BigInt(100_000), success: true });

      const result = await service.preview({
        chainId,
        safeAddress: getAddress(faker.finance.ethereumAddress()),
        to: getAddress(faker.finance.ethereumAddress()),
        value: '0',
        data: '0x',
        operation: Operation.CALL,
        gasToken: zeroAddress,
        numberSignatures: 2,
      });

      // 243k × 20 gwei × $2,500
      expect(result.relayCost.fiatValue).toBe('12.15');
      expect(result.pricingContextSnapshot.priceSource).toBe('coingecko');
      expect(mockNativePrices.getPrice).toHaveBeenCalled();
      expect(mockPricesApi.getTokenPrices).not.toHaveBeenCalled();
    });

    it('quotes a native fee without a USD price and leaves the display value null', async () => {
      mockChainsRepository.getRelayChain.mockResolvedValue({
        ...nativeRelayChain,
        nativeUsdPrice: null,
      });
      mockNativePrices.getPrice.mockResolvedValue(null);
      mockSimulation({ estimate: BigInt(100_000), success: true });

      const result = await service.preview({
        chainId,
        safeAddress: getAddress(faker.finance.ethereumAddress()),
        to: getAddress(faker.finance.ethereumAddress()),
        value: '0',
        data: '0x',
        operation: Operation.CALL,
        gasToken: zeroAddress,
        numberSignatures: 2,
      });

      expect(result.relayCost).toEqual({ fiatCode: 'USD', fiatValue: null });
      expect(result.pricingContextSnapshot.priceSource).toBe('unavailable');
      expect(BigInt(result.txData.gasPrice)).toBeGreaterThanOrEqual(
        parseGwei('20'),
      );
      await expect(
        service.assertRefundCovers({
          chainId,
          token: native,
          gasPrice: BigInt(result.txData.gasPrice),
          baseGas: BigInt(result.txData.baseGas),
          innerGasEstimate: BigInt(100_000),
          outerGasLimit: BigInt(243_000),
        }),
      ).resolves.toBeUndefined();
    });

    describe('assertRefundCovers', () => {
      const args = {
        chainId,
        token: native,
        gasPrice: parseGwei('24'),
        baseGas: BigInt(191_600),
        innerGasEstimate: BigInt(100_000),
        outerGasLimit: BigInt(243_000),
      };

      it('passes when (inner + baseGas) at the capped price covers outer gas plus the minimum margin', async () => {
        await expect(service.assertRefundCovers(args)).resolves.toBeUndefined();
        expect(mockPricesApi.getTokenPrices).not.toHaveBeenCalled();
      });

      // current 20 gwei × (1 + 5 % minimum margin) = 21 gwei
      it('passes a signed gas price exactly at current × (1 + minMargin)', async () => {
        await expect(
          service.assertRefundCovers({ ...args, gasPrice: parseGwei('21') }),
        ).resolves.toBeUndefined();
      });

      it('refuses a signed gas price one wei below current × (1 + minMargin)', async () => {
        const low = { ...args, gasPrice: parseGwei('21') - BigInt(1) };

        await expect(service.assertRefundCovers(low)).rejects.toThrow(
          'Propose it again to refresh the fee',
        );
        await expect(service.assertRefundCovers(low)).rejects.toThrow(
          'below the current network gas price',
        );
      });

      it('refuses a baseGas that leaves the outer gas uncovered', async () => {
        // 173k refundable gas < 243k × 1.05
        await expect(
          service.assertRefundCovers({ ...args, baseGas: BigInt(73_000) }),
        ).rejects.toThrow('no longer covers the gas cost');
      });

      it('refuses a margin carried only in gasPrice, which the refund cap discards', async () => {
        // the ERC-20 style quote: 24 gwei × (100k + 73k) looks like 1.2 × 20 gwei × 173k, yet pays at 20 gwei
        await expect(
          service.assertRefundCovers({
            ...args,
            baseGas: BigInt(73_000),
            outerGasLimit: BigInt(173_000),
          }),
        ).rejects.toThrow('no longer covers the gas cost');
      });
    });
  });

  describe('reserveNativeSpend', () => {
    it('allows quoting and relay without a per-chain budget and skips the counter', async () => {
      mockChainsRepository.getRelayChain.mockResolvedValue({
        ...relayChain,
        payFromSafeDailyBudgetWei: null,
      });
      mockSimulation({ estimate: BigInt(100_000), success: true });

      await expect(target.isEnabled(chainId)).resolves.toBe(true);
      await expect(
        target.preview({
          chainId,
          safeAddress: getAddress(faker.finance.ethereumAddress()),
          to: getAddress(faker.finance.ethereumAddress()),
          value: '0',
          data: null,
          operation: Operation.CALL,
          gasToken: usdc,
          numberSignatures: 1,
        }),
      ).resolves.toMatchObject({
        txData: { gasToken: usdc, refundReceiver },
      });
      await expect(
        target.reserveNativeSpend(chainId, BigInt(200_000)),
      ).resolves.toBeUndefined();
      expect(mockCacheService.increment).not.toHaveBeenCalled();
      expect(mockRelayApi.getGasPriceCap).not.toHaveBeenCalled();
      mockChainsRepository.getChain.mockResolvedValue({
        ...chain,
        features: [],
      });
      await expect(
        target.reserveNativeSpend(chainId, BigInt(200_000)),
      ).rejects.toThrow('not enabled');
    });

    it('atomically reserves selected gas at configured max price with a UTC date key', async () => {
      mockCacheService.increment.mockResolvedValue(6_000_000);

      await expect(
        target.reserveNativeSpend(chainId, BigInt(200_000)),
      ).resolves.toBeUndefined();

      expect(mockCacheService.increment).toHaveBeenCalledWith(
        `gas-token-spend:${chainId}:${new Date().toISOString().slice(0, 10)}`,
        172_800,
        0,
        6_000_000,
      );
    });

    it('fails closed when Redis reservation fails', async () => {
      mockCacheService.increment.mockRejectedValue(new Error('redis down'));

      await expect(
        target.reserveNativeSpend(chainId, BigInt(200_000)),
      ).rejects.toThrow('Unable to reserve');
    });

    it('rejects an overbudget reservation after atomic increment', async () => {
      mockCacheService.increment.mockResolvedValue(10_000_001);

      await expect(
        target.reserveNativeSpend(chainId, BigInt(200_000)),
      ).rejects.toThrow('daily gas budget exceeded');
    });

    it('accepts at most the configured budget under concurrent reservations', async () => {
      let total = 0;
      mockCacheService.increment.mockImplementation(
        (_key, _ttl, _deviation, amount = 1) => {
          total += amount;
          return Promise.resolve(total);
        },
      );

      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () =>
          target.reserveNativeSpend(chainId, BigInt(200_000)),
        ),
      );

      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === 'rejected'),
      ).toHaveLength(4);
    });

    it('rechecks the feature before reserving', async () => {
      mockChainsRepository.getChain.mockResolvedValue({
        ...chain,
        features: [],
      });

      await expect(
        target.reserveNativeSpend(chainId, BigInt(200_000)),
      ).rejects.toThrow('not enabled');
      expect(mockCacheService.increment).not.toHaveBeenCalled();
    });

    it('turns Pay from Safe off on a budgeted chain while the relayer has no gas price cap', async () => {
      mockRelayApi.getGasPriceCap.mockResolvedValue(null);

      await expect(target.isEnabled(chainId)).resolves.toBe(false);
      await expect(
        target.preview({
          chainId,
          safeAddress: getAddress(faker.finance.ethereumAddress()),
          to: getAddress(faker.finance.ethereumAddress()),
          value: '0',
          data: '0x',
          operation: Operation.CALL,
          gasToken: usdc,
          numberSignatures: 1,
        }),
      ).rejects.toThrow('not enabled on chain');
      await expect(
        target.reserveNativeSpend(chainId, BigInt(200_000)),
      ).rejects.toThrow('not enabled on chain');
      expect(mockCacheService.increment).not.toHaveBeenCalled();
      expect(mockLoggingService.error).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('no gas price cap'),
        }),
      );
    });

    it('does not consult the relayer cap without a budget', async () => {
      mockChainsRepository.getRelayChain.mockResolvedValue({
        ...relayChain,
        payFromSafeDailyBudgetWei: null,
      });
      mockRelayApi.getGasPriceCap.mockResolvedValue(null);

      await expect(target.isEnabled(chainId)).resolves.toBe(true);
      expect(mockRelayApi.getGasPriceCap).not.toHaveBeenCalled();
    });
  });

  describe('simulate', () => {
    it('should return the estimated gas', async () => {
      mockPublicClient.estimateGas.mockResolvedValue(BigInt(123_456));
      const safeAddress = getAddress(faker.finance.ethereumAddress());

      await expect(
        target.simulate({ chainId, safeAddress, data: '0xdeadbeef' }),
      ).resolves.toBe(BigInt(123_456));
      // without a gas price the call shape stays exactly as before
      const request = {
        account: '0x0000000000000000000000000000000000000001',
        to: safeAddress,
        data: '0xdeadbeef',
      };
      expect(mockPublicClient.estimateGas.mock.calls[0][0]).toStrictEqual(
        request,
      );
      expect(mockPublicClient.call.mock.calls[0][0]).toStrictEqual(request);
    });

    it('should simulate at the signed gas price with a funded sender when given', async () => {
      mockPublicClient.estimateGas.mockResolvedValue(BigInt(123_456));
      const safeAddress = getAddress(faker.finance.ethereumAddress());

      await expect(
        target.simulate({
          chainId,
          safeAddress,
          data: '0xdeadbeef',
          gasPrice: parseGwei('24'),
        }),
      ).resolves.toBe(BigInt(123_456));

      const request = {
        account: '0x0000000000000000000000000000000000000001',
        to: safeAddress,
        data: '0xdeadbeef',
        gasPrice: parseGwei('24'),
        stateOverride: [
          {
            address: '0x0000000000000000000000000000000000000001',
            balance: BigInt(10) ** BigInt(30),
          },
        ],
      };
      expect(mockPublicClient.estimateGas.mock.calls[0][0]).toStrictEqual(
        request,
      );
      expect(mockPublicClient.call.mock.calls[0][0]).toStrictEqual(request);
    });

    it('should turn a native refund revert at the signed price into SIMULATION_FAILED', async () => {
      mockPublicClient.estimateGas.mockRejectedValue(new Error('GS011'));

      const error: unknown = await target
        .simulate({
          chainId,
          safeAddress: getAddress(faker.finance.ethereumAddress()),
          data: '0xdeadbeef',
          gasPrice: parseGwei('24'),
        })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(GasTokenRelayError);
      expect((error as GasTokenRelayError).getResponse()).toMatchObject({
        code: 'SIMULATION_FAILED',
        message: 'Simulation failed: GS011',
      });
    });

    it('should reject when the signed Safe execution returns false', async () => {
      mockPublicClient.estimateGas.mockResolvedValue(BigInt(123_456));
      mockPublicClient.call.mockResolvedValue({
        data: encodeAbiParameters([{ type: 'bool' }], [false]),
      });

      await expect(
        target.simulate({
          chainId,
          safeAddress: getAddress(faker.finance.ethereumAddress()),
          data: '0xdeadbeef',
        }),
      ).rejects.toThrow('Simulation failed');
    });

    it('should fail closed when the signed execution result is malformed', async () => {
      mockPublicClient.estimateGas.mockResolvedValue(BigInt(123_456));
      mockPublicClient.call.mockResolvedValue({ data: '0x1234' });

      await expect(
        target.simulate({
          chainId,
          safeAddress: getAddress(faker.finance.ethereumAddress()),
          data: '0xdeadbeef',
        }),
      ).rejects.toThrow('Simulation failed');
    });

    it('should turn a revert into a 422 with the reason', async () => {
      mockPublicClient.estimateGas.mockRejectedValue(new Error('GS012'));

      await expect(
        target.simulate({
          chainId,
          safeAddress: getAddress(faker.finance.ethereumAddress()),
          data: '0x',
        }),
      ).rejects.toThrow('Simulation failed: GS012');
    });
  });

  describe('zero fee margin', () => {
    it('disables Safe-pays and logs an error when minMarginBps is 0', async () => {
      const config = new FakeConfigurationService();
      config.set('relay.gasToken', { ...configuration, minMarginBps: 0 });

      expect(() => buildService(config, mockLoggingService)).not.toThrow();
      const service = buildService(config, mockLoggingService);

      await expect(service.isEnabled(chainId)).resolves.toBe(false);
      expect(mockLoggingService.error).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('relay.gasToken.minMarginBps'),
        }),
      );
    });

    it('keeps Safe-pays enabled with the default margin', async () => {
      const config = new FakeConfigurationService();
      config.set('relay.gasToken', configuration);

      const service = buildService(config, mockLoggingService);

      await expect(service.isEnabled(chainId)).resolves.toBe(true);
      expect(mockLoggingService.error).not.toHaveBeenCalled();
    });
  });

  describe('relay settings from config-service', () => {
    it('is off and logs an error with PAY_FROM_SAFE but no relay settings', async () => {
      mockChainsRepository.getRelayChain.mockResolvedValue(null);

      await expect(target.isEnabled(chainId)).resolves.toBe(false);
      expect(mockLoggingService.error).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining(
            `chain ${chainId} without relay settings`,
          ),
        }),
      );
    });

    it('is off without logging when the flag is off', async () => {
      mockChainsRepository.getChain.mockResolvedValue({
        ...chain,
        features: [],
      });
      mockChainsRepository.getRelayChain.mockResolvedValue(null);

      await expect(target.isEnabled(chainId)).resolves.toBe(false);
      expect(mockLoggingService.error).not.toHaveBeenCalled();
    });

    it('matches a lowercase fee token and keeps the configured checksum', async () => {
      await expect(
        target.getAllowlistedToken(
          chainId,
          usdc.toLowerCase() as `0x${string}`,
        ),
      ).resolves.toMatchObject({ address: usdc, symbol: 'USDC' });
    });

    it.each([
      ['1000000000', 1],
      ['999999999', 0],
      ['1000000000000000000', 1_000_000_000],
      ['100000000000000000', 100_000_000],
      [
        '115792089237316195423570985008687907853269984665640564039457584007913129639935',
        Number.MAX_SAFE_INTEGER,
      ],
    ])('converts a %s wei budget to %i gwei', (budgetWei, gwei) => {
      expect(GasTokenFeeService.toDailyLimitGwei(budgetWei)).toBe(gwei);
    });
  });

  describe('simulate without the Safe result check', () => {
    it('returns the estimate without calling eth_call', async () => {
      mockPublicClient.estimateGas.mockResolvedValue(BigInt(250_000));
      const factory = getAddress(faker.finance.ethereumAddress());

      await expect(
        target.simulate({
          chainId,
          safeAddress: factory,
          data: '0xdeadbeef',
          checkSafeResult: false,
        }),
      ).resolves.toBe(BigInt(250_000));
      expect(mockPublicClient.call).not.toHaveBeenCalled();
    });

    it('still turns a revert into SIMULATION_FAILED', async () => {
      mockPublicClient.estimateGas.mockRejectedValue(new Error('GS013'));

      await expect(
        target.simulate({
          chainId,
          safeAddress: getAddress(faker.finance.ethereumAddress()),
          data: '0x',
          checkSafeResult: false,
        }),
      ).rejects.toThrow('Simulation failed: GS013');
    });
  });

  describe('reserveGasBudget', () => {
    const args = {
      key: 'sponsored-spend:84532:2026-09-28',
      outerGasLimit: BigInt(250_000),
      dailyLimitGwei: 100_000_000,
      maxGasPriceWei: '500000000',
    };

    it('reserves ceil(gas × price / 1e9) gwei atomically and does not check PAY_FROM_SAFE', async () => {
      mockChainsRepository.getChain.mockResolvedValue({
        ...chain,
        features: [],
      });
      mockCacheService.increment.mockResolvedValue(125_000);

      await expect(target.reserveGasBudget(args)).resolves.toBe('reserved');
      expect(mockCacheService.increment).toHaveBeenCalledWith(
        args.key,
        172_800,
        0,
        125_000,
      );
      expect(mockChainsRepository.getChain).not.toHaveBeenCalled();
    });

    it('returns exceeded above the limit', async () => {
      mockCacheService.increment.mockResolvedValue(100_000_001);

      await expect(target.reserveGasBudget(args)).resolves.toBe('exceeded');
    });

    it('returns unavailable when the cache fails', async () => {
      mockCacheService.increment.mockRejectedValue(new Error('redis down'));

      await expect(target.reserveGasBudget(args)).resolves.toBe('unavailable');
    });

    it('returns exceeded without touching the cache when the amount is not a safe integer', async () => {
      await expect(
        target.reserveGasBudget({
          ...args,
          outerGasLimit: BigInt(Number.MAX_SAFE_INTEGER),
          maxGasPriceWei: '1000000000000',
        }),
      ).resolves.toBe('exceeded');
      expect(mockCacheService.increment).not.toHaveBeenCalled();
    });
  });

  describe('dayKey', () => {
    afterEach(() => jest.useRealTimers());

    it('uses the UTC date', () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-09-28T23:59:59.000Z'));
      expect(GasTokenFeeService.dayKey('sponsored-spend', '84532')).toBe(
        'sponsored-spend:84532:2026-09-28',
      );
      jest.setSystemTime(new Date('2026-09-29T00:00:01.000Z'));
      expect(GasTokenFeeService.dayKey('sponsored-spend', '84532')).toBe(
        'sponsored-spend:84532:2026-09-29',
      );
    });
  });
});
