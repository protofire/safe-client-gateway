import type { RelayNativePriceService } from '@/modules/relay/domain/relay-native-price.service';
import { faker } from '@faker-js/faker';
import {
  concatHex,
  encodeAbiParameters,
  getAddress,
  numberToHex,
  parseGwei,
  size,
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
import {
  GasTokenConfigurationSchema,
  type GasTokenConfiguration,
} from '@/modules/relay/domain/entities/gas-token.configuration';
import { Operation } from '@/modules/safe/domain/entities/operation.entity';
import { rawify } from '@/validation/entities/raw.entity';

const mockChainsRepository = jest.mocked({
  getChain: jest.fn(),
} as jest.MockedObjectDeep<IChainsRepository>);

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
    refundReceivers: { [chainId]: refundReceiver },
    nativeUsdPrices: {},
    allowlist: {
      [chainId]: [{ address: usdc, symbol: 'USDC', decimals: 6, usdPrice: 1 }],
    },
    marginBps: 2_000,
    minMarginBps: 500,
    baseGas: 70_000,
    baseGasPerSignature: 1_500,
    gasLimitBuffer: 50_000,
    nativeSpendBudgets: {
      [chainId]: { dailyLimitGwei: 10_000_000, maxGasPriceWei: '30000000000' },
    },
  };
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
    it('should refuse a chain without the GAS_TOKEN feature', async () => {
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
          GasTokenConfigurationSchema.parse({
            ...configuration,
            allowlist: { [chainId]: [{ address: usdc, symbol, decimals: 6 }] },
          }),
        ).toThrow();
      },
    );

    it('should expose enabled token configuration', () => {
      expect(target.getConfiguration(chainId)).toStrictEqual({
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
      const fakeConfigurationService = new FakeConfigurationService();
      fakeConfigurationService.set('relay.gasToken', {
        ...configuration,
        allowlist: {
          [chainId]: [{ address: dai, symbol: 'DAI', decimals: 18 }],
        },
      });
      target = buildService(fakeConfigurationService);
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
      const fakeConfigurationService = new FakeConfigurationService();
      fakeConfigurationService.set('relay.gasToken', {
        ...configuration,
        nativeUsdPrices: { [chainId]: 5_000 },
      });
      target = buildService(fakeConfigurationService);
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
        const config = new FakeConfigurationService();
        const token = { address: usdc, symbol: 'USD', decimals, usdPrice: 1 };
        config.set('relay.gasToken', {
          ...configuration,
          allowlist: { [chainId]: [token] },
        });
        const service = buildService(config);
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
    const token = configuration.allowlist[chainId][0];
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

  describe('reserveNativeSpend', () => {
    it('allows quoting and relay without a per-chain budget and skips the counter', async () => {
      const budgets = configuration.nativeSpendBudgets;
      configuration.nativeSpendBudgets = {};
      mockSimulation({ estimate: BigInt(100_000), success: true });
      try {
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
        mockChainsRepository.getChain.mockResolvedValue({
          ...chain,
          features: [],
        });
        await expect(
          target.reserveNativeSpend(chainId, BigInt(200_000)),
        ).rejects.toThrow('not enabled');
      } finally {
        configuration.nativeSpendBudgets = budgets;
      }
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
  });

  describe('simulate', () => {
    it('should return the estimated gas', async () => {
      mockPublicClient.estimateGas.mockResolvedValue(BigInt(123_456));
      const safeAddress = getAddress(faker.finance.ethereumAddress());

      await expect(
        target.simulate({ chainId, safeAddress, data: '0xdeadbeef' }),
      ).resolves.toBe(BigInt(123_456));
      expect(mockPublicClient.estimateGas).toHaveBeenCalledWith({
        account: '0x0000000000000000000000000000000000000001',
        to: safeAddress,
        data: '0xdeadbeef',
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
});
