import { faker } from '@faker-js/faker';
import { getAddress, type Hex } from 'viem';
import type { Relay } from '@/modules/relay/domain/entities/relay.entity';
import { FakeConfigurationService } from '@/config/__tests__/fake.configuration.service';
import { FakeCacheService } from '@/datasources/cache/__tests__/fake.cache.service';
import type { IRelayApi } from '@/domain/interfaces/relay-api.interface';
import type { IBlockchainApiManager } from '@/domain/interfaces/blockchain-api.manager.interface';
import type { ILoggingService } from '@/logging/logging.interface';
import type { IChainsRepository } from '@/modules/chains/domain/chains.repository.interface';
import { chainBuilder } from '@/modules/chains/domain/entities/__tests__/chain.builder';
import { execTransactionEncoder } from '@/modules/contracts/domain/__tests__/encoders/safe-encoder.builder';
import { SafeDecoder } from '@/modules/contracts/domain/decoders/safe-decoder.helper';
import { MultiSendDecoder } from '@/modules/contracts/domain/decoders/multi-send-decoder.helper';
import { ProxyFactoryDecoder } from '@/modules/relay/domain/contracts/decoders/proxy-factory-decoder.helper';
import { createProxyWithNonceEncoder } from '@/modules/relay/domain/contracts/__tests__/encoders/proxy-factory-encoder.builder';
import { GasTokenFeeService } from '@/modules/relay/domain/gas-token-fee.service';
import type { LimitAddressesMapper } from '@/modules/relay/domain/limit-addresses.mapper';
import { DailyLimitRelayer } from '@/modules/relay/domain/relayers/daily-limit.relayer';
import { RelayLimitReachedError } from '@/modules/relay/domain/errors/relay-limit-reached.error';
import { ExceedsMaxGasLimitError } from '@/modules/relay/domain/errors/exceeds-max-gas-limit';
import { rawify } from '@/validation/entities/raw.entity';

const mockLogging = {
  info: jest.fn(),
  warn: jest.fn(),
} as unknown as jest.Mocked<ILoggingService>;
const mockMapper = {
  getLimitAddresses: jest.fn(),
} as unknown as jest.Mocked<LimitAddressesMapper>;
const mockRelayApi = { relay: jest.fn() } as unknown as jest.Mocked<IRelayApi>;
const mockChains = {
  getChain: jest.fn(),
} as unknown as jest.Mocked<IChainsRepository>;
const mockClient = { getCode: jest.fn() };
const mockBlockchain = {
  getApi: jest.fn(),
} as unknown as jest.Mocked<IBlockchainApiManager>;
const mockFee = {
  simulate: jest.fn(),
  reserveGasBudget: jest.fn(),
} as unknown as jest.Mocked<GasTokenFeeService>;

describe('DailyLimitRelayer (sponsored)', () => {
  const chainId = '84532';
  const entry = {
    perSafePerDay: 3,
    perOwnerCreationsPerDay: 2,
    maxGasLimit: 1_000_000,
    dailyBudgetGwei: 100_000_000,
    maxGasPriceWei: '500000000',
  };
  const safe = getAddress(faker.finance.ethereumAddress());
  const execData = execTransactionEncoder().encode();
  let cache: FakeCacheService;
  let target: DailyLimitRelayer;

  const build = (
    sponsoredChains: Record<string, typeof entry> = { [chainId]: entry },
  ): DailyLimitRelayer => {
    const config = new FakeConfigurationService();
    config.set('relay.sponsoredChains', sponsoredChains);
    config.set('relay.gasToken', { gasLimitBuffer: 50_000 });
    return new DailyLimitRelayer(
      mockLogging,
      config,
      mockMapper,
      mockRelayApi,
      mockChains,
      mockBlockchain,
      cache,
      mockFee,
      new SafeDecoder(),
      new MultiSendDecoder(mockLogging),
      new ProxyFactoryDecoder(),
    );
  };

  beforeEach(() => {
    jest.resetAllMocks();
    jest.useRealTimers();
    cache = new FakeCacheService();
    mockChains.getChain.mockResolvedValue(
      chainBuilder()
        .with('chainId', chainId)
        .with('features', ['RELAYING'])
        .build(),
    );
    mockBlockchain.getApi.mockResolvedValue(mockClient as never);
    mockClient.getCode.mockResolvedValue('0x6080'); // deployed Safe unless a test says otherwise
    mockMapper.getLimitAddresses.mockResolvedValue([safe]);
    mockFee.simulate.mockResolvedValue(BigInt(100_000));
    mockFee.reserveGasBudget.mockResolvedValue('reserved');
    mockRelayApi.relay.mockResolvedValue(
      rawify({ taskId: faker.string.uuid() }),
    );
    target = build();
  });

  const relay = (
    data: Hex = execData,
    gasLimit: bigint | null = null,
  ): Promise<Relay> =>
    target.relay({ version: '1.4.1', chainId, to: safe, data, gasLimit });

  it('refuses a chain without RELAYING before any other work', async () => {
    mockChains.getChain.mockResolvedValue(
      chainBuilder().with('chainId', chainId).with('features', []).build(),
    );
    await expect(relay()).rejects.toMatchObject({
      response: { code: 'CHAIN_NOT_SPONSORED', statusCode: 422 },
    });
    expect(mockMapper.getLimitAddresses).not.toHaveBeenCalled();
    expect(mockRelayApi.relay).not.toHaveBeenCalled();
  });

  it('refuses a RELAYING chain without an env entry', async () => {
    target = build({});
    await expect(relay()).rejects.toMatchObject({
      response: { code: 'CHAIN_NOT_SPONSORED' },
    });
    expect(mockRelayApi.relay).not.toHaveBeenCalled();
  });

  it('checks the Safe result for execTransaction and relays with estimate + buffer', async () => {
    await relay();
    expect(mockFee.simulate).toHaveBeenCalledWith({
      chainId,
      safeAddress: safe,
      data: execData,
      checkSafeResult: true,
    });
    expect(mockRelayApi.relay).toHaveBeenCalledWith({
      chainId,
      to: safe,
      data: execData,
      gasLimit: BigInt(150_000),
    });
  });

  it('simulates createProxyWithNonce without the Safe result check and limits per owner', async () => {
    const owners = [
      getAddress(faker.finance.ethereumAddress()),
      getAddress(faker.finance.ethereumAddress()),
    ];
    mockMapper.getLimitAddresses.mockResolvedValue(owners);
    const data = createProxyWithNonceEncoder().encode();
    await relay(data);
    await relay(data);
    await expect(relay(data)).rejects.toBeInstanceOf(RelayLimitReachedError); // perOwnerCreationsPerDay 2
    expect(mockFee.simulate).toHaveBeenCalledWith(
      expect.objectContaining({ checkSafeResult: false }),
    );
  });

  it('does not let creations naming a Safe as owner burn that Safe’s quota', async () => {
    const data = createProxyWithNonceEncoder().encode();
    mockMapper.getLimitAddresses.mockResolvedValue([safe]);
    await relay(data);
    await relay(data);
    mockMapper.getLimitAddresses.mockResolvedValue([safe]);
    await expect(
      target.getRelaysRemaining({ chainId, address: safe }),
    ).resolves.toEqual({ remaining: 3, limit: 3 });
    await relay();
    await relay();
    await relay();
    expect(mockRelayApi.relay).toHaveBeenCalledTimes(5);
  });

  it('does not reserve quota or budget when simulation fails', async () => {
    mockFee.simulate.mockRejectedValue(new Error('Simulation failed: GS013'));
    await expect(relay()).rejects.toThrow('Simulation failed');
    expect(mockFee.reserveGasBudget).not.toHaveBeenCalled();
    await expect(
      target.getRelaysRemaining({ chainId, address: safe }),
    ).resolves.toEqual(expect.objectContaining({ remaining: 3 }));
  });

  it('refuses above maxGasLimit, also when the client asks for more', async () => {
    await expect(relay(execData, BigInt(1_000_001))).rejects.toBeInstanceOf(
      ExceedsMaxGasLimitError,
    );
    mockFee.simulate.mockResolvedValue(BigInt(990_000));
    await expect(relay()).rejects.toBeInstanceOf(ExceedsMaxGasLimitError);
    expect(mockRelayApi.relay).not.toHaveBeenCalled();
  });

  it('uses a larger client gasLimit within the cap', async () => {
    await relay(execData, BigInt(400_000));
    expect(mockRelayApi.relay).toHaveBeenCalledWith(
      expect.objectContaining({ gasLimit: BigInt(400_000) }),
    );
  });

  it('enforces perSafePerDay atomically under concurrency', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => relay()),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    expect(mockRelayApi.relay).toHaveBeenCalledTimes(3);
  });

  it('reserves the budget on the sponsored key and refuses when exhausted', async () => {
    mockFee.reserveGasBudget.mockResolvedValue('exceeded');
    await expect(relay()).rejects.toMatchObject({
      response: { code: 'BUDGET_EXHAUSTED', statusCode: 422 },
    });
    expect(mockFee.reserveGasBudget).toHaveBeenCalledWith({
      key: GasTokenFeeService.dayKey('sponsored-spend', chainId),
      outerGasLimit: BigInt(150_000),
      dailyLimitGwei: entry.dailyBudgetGwei,
      maxGasPriceWei: entry.maxGasPriceWei,
    });
    expect(mockRelayApi.relay).not.toHaveBeenCalled();
  });

  it('treats an unavailable budget cache as exhausted (fail closed)', async () => {
    mockFee.reserveGasBudget.mockResolvedValue('unavailable');
    await expect(relay()).rejects.toMatchObject({
      response: { code: 'BUDGET_EXHAUSTED' },
    });
  });

  it('logs one sponsored line with the kind', async () => {
    await relay();
    expect(mockLogging.info).toHaveBeenCalledWith(
      expect.stringMatching(
        /^Sponsored relay .+ \| chain 84532 \| kind exec \| limited .+ \| gasLimit 150000$/,
      ),
    );
  });

  describe('getRelaysRemaining', () => {
    it('returns {0,0} on a chain that is not sponsored', async () => {
      target = build({});
      await expect(
        target.getRelaysRemaining({ chainId, address: safe }),
      ).resolves.toEqual({ remaining: 0, limit: 0 });
    });

    it('returns {0,0} when today’s budget is used', async () => {
      await cache.increment(
        GasTokenFeeService.dayKey('sponsored-spend', chainId),
        60,
        0,
        entry.dailyBudgetGwei,
      );
      await expect(
        target.getRelaysRemaining({ chainId, address: safe }),
      ).resolves.toEqual({ remaining: 0, limit: 0 });
    });

    it('uses perSafePerDay for a contract and reports what the POST reserved', async () => {
      mockClient.getCode.mockResolvedValue('0x6080');
      await relay();
      await expect(
        target.getRelaysRemaining({ chainId, address: safe }),
      ).resolves.toEqual({ remaining: 2, limit: 3 });
    });

    it('uses perOwnerCreationsPerDay for an address without code', async () => {
      mockClient.getCode.mockResolvedValue(undefined);
      await expect(
        target.getRelaysRemaining({ chainId, address: safe }),
      ).resolves.toEqual({ remaining: 2, limit: 2 });
    });

    it('reports creation usage for an address without code', async () => {
      mockMapper.getLimitAddresses.mockResolvedValue([safe]);
      await relay(createProxyWithNonceEncoder().encode());
      mockClient.getCode.mockResolvedValue(undefined);
      await expect(
        target.getRelaysRemaining({ chainId, address: safe }),
      ).resolves.toEqual({ remaining: 1, limit: 2 });
    });

    it('reports Safe usage, not creation usage, for a contract', async () => {
      await relay();
      mockMapper.getLimitAddresses.mockResolvedValue([safe]);
      await relay(createProxyWithNonceEncoder().encode());
      mockClient.getCode.mockResolvedValue('0x6080');
      await expect(
        target.getRelaysRemaining({ chainId, address: safe }),
      ).resolves.toEqual({ remaining: 2, limit: 3 });
    });

    it('matches the POST key regardless of address case', async () => {
      mockClient.getCode.mockResolvedValue('0x6080');
      await relay();
      await expect(
        target.getRelaysRemaining({
          chainId,
          address: safe.toLowerCase() as `0x${string}`,
        }),
      ).resolves.toEqual({ remaining: 2, limit: 3 });
    });

    it('resets at UTC midnight', async () => {
      mockClient.getCode.mockResolvedValue('0x6080');
      jest
        .useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] })
        .setSystemTime(new Date('2026-09-28T23:59:59.000Z'));
      await relay();
      jest.setSystemTime(new Date('2026-09-29T00:00:01.000Z'));
      await expect(
        target.getRelaysRemaining({ chainId, address: safe }),
      ).resolves.toEqual({ remaining: 3, limit: 3 });
    });
  });
});
