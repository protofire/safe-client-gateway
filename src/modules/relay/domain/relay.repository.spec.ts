import { zeroAddress } from 'viem';
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
  it('returns an empty capability when GAS_TOKEN is disabled', async () => {
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
