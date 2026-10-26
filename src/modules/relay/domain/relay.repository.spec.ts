import { getAddress, zeroAddress } from 'viem';
import { faker } from '@faker-js/faker';
import { SafeDecoder } from '@/modules/contracts/domain/decoders/safe-decoder.helper';
import { execTransactionEncoder } from '@/modules/contracts/domain/__tests__/encoders/safe-encoder.builder';
import { createProxyWithNonceEncoder } from '@/modules/relay/domain/contracts/__tests__/encoders/proxy-factory-encoder.builder';
import { RelayRepository } from '@/modules/relay/domain/relay.repository';
import type { IRelayManager } from '@/modules/relay/domain/interfaces/relay-manager.interface';
import type { IRelayApi } from '@/domain/interfaces/relay-api.interface';
import { FakeConfigurationService } from '@/config/__tests__/fake.configuration.service';
import type { IChainsRepository } from '@/modules/chains/domain/chains.repository.interface';
import { chainBuilder } from '@/modules/chains/domain/entities/__tests__/chain.builder';
import type { RelayChain } from '@/modules/relay/domain/entities/gas-token.configuration';
import { relayChainBuilder } from '@/modules/relay/domain/entities/__tests__/relay-chain.builder';
import { GasTokenFeeService } from '@/modules/relay/domain/gas-token-fee.service';
import type { ILoggingService } from '@/logging/logging.interface';
import type { GasTokenRelayer } from '@/modules/relay/domain/relayers/gas-token.relayer';
import type { RelayScreeningService } from '@/modules/relay/domain/sanctions/relay-screening.service';

describe('RelayRepository gas token capability', () => {
  it('returns an empty capability when PAY_FROM_SAFE is disabled', async () => {
    const relayManager = {} as IRelayManager;
    const relayApi = {} as IRelayApi;
    const gasTokenRelayer = {} as GasTokenRelayer;
    const feeService = {
      isEnabled: jest.fn().mockResolvedValue(false),
      getConfiguration: jest.fn(),
    } as unknown as GasTokenFeeService;
    const relayScreeningService = { screen: jest.fn() };
    const repository = new RelayRepository(
      relayManager,
      relayApi,
      gasTokenRelayer,
      feeService,
      relayScreeningService as unknown as RelayScreeningService,
      {} as ILoggingService,
      new SafeDecoder(),
    );

    await expect(repository.getGasTokenConfiguration('1')).resolves.toEqual({
      gasTokens: [],
      refundReceiver: null,
    });
    expect(feeService.getConfiguration).not.toHaveBeenCalled();
  });

  it.each([
    [false, { gasTokens: [], refundReceiver: null }],
    [true, { gasTokens: ['configured'], refundReceiver: '0xreceiver' }],
  ])(
    'offers Safe-pays only while the chain relayer is available (%s)',
    async (available, expected) => {
      const relayApi = {
        isAvailable: jest.fn().mockResolvedValue(available),
      } as unknown as IRelayApi;
      const feeService = {
        isEnabled: jest.fn().mockResolvedValue(true),
        getConfiguration: jest.fn().mockResolvedValue({
          gasTokens: ['configured'],
          refundReceiver: '0xreceiver',
        }),
      } as unknown as GasTokenFeeService;
      const repository = new RelayRepository(
        {} as IRelayManager,
        relayApi,
        {} as GasTokenRelayer,
        feeService,
        { screen: jest.fn() } as unknown as RelayScreeningService,
        {} as ILoggingService,
        new SafeDecoder(),
      );

      await expect(
        repository.getGasTokenConfiguration('8453'),
      ).resolves.toEqual(expected);
      expect(relayApi.isAvailable).toHaveBeenCalledWith('8453');
    },
  );

  it.each([
    [false, { gasTokens: [], refundReceiver: null }],
    [
      true,
      {
        gasTokens: [{ address: zeroAddress, symbol: 'USDC', decimals: 18 }],
        refundReceiver: '0xreceiver',
      },
    ],
  ])(
    'hides a native-coin fee entry while the chain relayer is unavailable (%s)',
    async (available, expected) => {
      const relayApi = {
        isAvailable: jest.fn().mockResolvedValue(available),
      } as unknown as IRelayApi;
      const feeService = {
        isEnabled: jest.fn().mockResolvedValue(true),
        getConfiguration: jest.fn().mockReturnValue({
          gasTokens: [{ address: zeroAddress, symbol: 'USDC', decimals: 18 }],
          refundReceiver: '0xreceiver',
        }),
      } as unknown as GasTokenFeeService;
      const repository = new RelayRepository(
        {} as IRelayManager,
        relayApi,
        {} as GasTokenRelayer,
        feeService,
        { screen: jest.fn() } as unknown as RelayScreeningService,
        {} as ILoggingService,
        new SafeDecoder(),
      );

      await expect(
        repository.getGasTokenConfiguration('5042'),
      ).resolves.toEqual(expected);
      expect(relayApi.isAvailable).toHaveBeenCalledWith('5042');
    },
  );
});

describe('RelayRepository fee tokens from config-service settings', () => {
  const build = (
    relayChain: RelayChain | null,
    gasPriceCap: bigint | null,
  ): RelayRepository => {
    const config = new FakeConfigurationService();
    config.set('relay.gasToken', {
      marginBps: 2_000,
      minMarginBps: 500,
      baseGas: 70_000,
      baseGasPerSignature: 1_500,
      gasLimitBuffer: 50_000,
    });
    const chainsRepository = {
      getChain: jest
        .fn()
        .mockResolvedValue(
          chainBuilder()
            .with('chainId', '84532')
            .with('features', [GasTokenFeeService.FEATURE])
            .build(),
        ),
      getRelayChain: jest.fn().mockResolvedValue(relayChain),
    } as unknown as IChainsRepository;
    const relayApi = {
      isAvailable: jest.fn().mockResolvedValue(true),
      getGasPriceCap: jest.fn().mockResolvedValue(gasPriceCap),
    } as unknown as IRelayApi;
    // Real fee service: the flag/settings/cap gate is what /fees must reflect
    const feeService = new GasTokenFeeService(
      config,
      chainsRepository,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { error: jest.fn() } as unknown as ILoggingService,
      relayApi,
    );
    return new RelayRepository(
      {} as IRelayManager,
      relayApi,
      {} as GasTokenRelayer,
      feeService,
      { screen: jest.fn() } as unknown as RelayScreeningService,
      {} as ILoggingService,
      new SafeDecoder(),
    );
  };

  it('lists no fee tokens with PAY_FROM_SAFE on but no relay settings', async () => {
    await expect(
      build(null, BigInt(1)).getGasTokenConfiguration('84532'),
    ).resolves.toEqual({ gasTokens: [], refundReceiver: null });
  });

  it('lists no fee tokens with a daily budget but no relayer gas price cap', async () => {
    const relayChain = relayChainBuilder()
      .with('payFromSafeDailyBudgetWei', '1000000000000000000')
      .build();
    await expect(
      build(relayChain, null).getGasTokenConfiguration('84532'),
    ).resolves.toEqual({ gasTokens: [], refundReceiver: null });
  });

  it('lists the configured tokens and receiver otherwise', async () => {
    const relayChain = relayChainBuilder().build();
    await expect(
      build(relayChain, null).getGasTokenConfiguration('84532'),
    ).resolves.toEqual({
      gasTokens: relayChain.tokens.map(({ address, symbol, decimals }) => ({
        address,
        symbol,
        decimals,
      })),
      refundReceiver: relayChain.refundReceiver,
    });
  });
});

describe('RelayRepository RELAY_RECORD', () => {
  const safe = getAddress(faker.finance.ethereumAddress());
  const gasToken = getAddress(faker.finance.ethereumAddress());
  const list = {
    sourceSha256: 'a'.repeat(64),
    sourcePublishDate: '2026-10-01',
    checkedAt: '2026-10-26T10:00:00.000Z',
  };
  const logging = { info: jest.fn() };
  const sponsoredRelayer = {
    relay: jest.fn().mockResolvedValue({ taskId: 'r1:sponsored' }),
  };
  const gasTokenRelayer = {
    getSafePaysFee: jest.fn(),
    relay: jest.fn().mockResolvedValue({ taskId: 'r1:safe-pays' }),
  };
  const screen = jest.fn();
  const repository = new RelayRepository(
    { getRelayer: () => sponsoredRelayer } as unknown as IRelayManager,
    {} as IRelayApi,
    gasTokenRelayer as unknown as GasTokenRelayer,
    {} as GasTokenFeeService,
    { screen } as unknown as RelayScreeningService,
    logging as unknown as ILoggingService,
    new SafeDecoder(),
  );
  const relay = (data: `0x${string}`): Promise<unknown> =>
    repository.relay({
      version: '1.4.1',
      chainId: '8453',
      to: safe,
      data,
      gasLimit: null,
    });
  const record = (): Record<string, unknown> => {
    expect(logging.info).toHaveBeenCalledTimes(1);
    return logging.info.mock.calls[0][0];
  };

  beforeEach(() => {
    jest.clearAllMocks();
    screen.mockResolvedValue({ result: 'clear', list });
  });

  it('records a sponsored relay with the screening result', async () => {
    gasTokenRelayer.getSafePaysFee.mockReturnValue(null);
    const data = execTransactionEncoder().encode();

    await relay(data);

    expect(record()).toEqual({
      type: 'RELAY_RECORD',
      chainId: '8453',
      taskId: 'r1:sponsored',
      kind: 'sponsored',
      safe,
      to: safe,
      dataHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
      gasToken: null,
      screening: { result: 'clear', list },
      at: expect.any(String),
    });
  });

  it('records a Safe-pays relay with its gas token', async () => {
    gasTokenRelayer.getSafePaysFee.mockReturnValue({ gasToken });
    const data = execTransactionEncoder().with('gasPrice', BigInt(1)).encode();

    await relay(data);

    expect(record()).toMatchObject({
      type: 'RELAY_RECORD',
      taskId: 'r1:safe-pays',
      kind: 'safe-pays',
      safe,
      gasToken,
      screening: { result: 'clear', list },
    });
  });

  it('records screening as disabled when it is switched off', async () => {
    gasTokenRelayer.getSafePaysFee.mockReturnValue(null);
    screen.mockResolvedValue('disabled');

    await relay(execTransactionEncoder().encode());

    expect(record()).toMatchObject({ screening: 'disabled' });
  });

  it('has no Safe for a Safe creation and carries no IP or header fields', async () => {
    gasTokenRelayer.getSafePaysFee.mockReturnValue(null);

    await relay(createProxyWithNonceEncoder().encode());

    expect(record()).toMatchObject({ safe: null });
    expect(Object.keys(record()).sort()).toEqual(
      [
        'at',
        'chainId',
        'dataHash',
        'gasToken',
        'kind',
        'safe',
        'screening',
        'taskId',
        'to',
        'type',
      ].sort(),
    );
  });

  it('records nothing when the relayer refuses', async () => {
    gasTokenRelayer.getSafePaysFee.mockReturnValue(null);
    sponsoredRelayer.relay.mockRejectedValueOnce(new Error('refused'));

    await expect(relay(execTransactionEncoder().encode())).rejects.toThrow();

    expect(logging.info).not.toHaveBeenCalled();
  });
});
