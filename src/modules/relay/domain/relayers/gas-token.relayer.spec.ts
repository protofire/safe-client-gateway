import { faker } from '@faker-js/faker';
import { getAddress, parseEther, parseGwei, zeroAddress } from 'viem';
import type { PublicClient } from 'viem';
import type { IBlockchainApiManager } from '@/domain/interfaces/blockchain-api.manager.interface';
import { FakeConfigurationService } from '@/config/__tests__/fake.configuration.service';
import type { IRelayApi } from '@/domain/interfaces/relay-api.interface';
import type { ILoggingService } from '@/logging/logging.interface';
import { execTransactionEncoder } from '@/modules/contracts/domain/__tests__/encoders/safe-encoder.builder';
import { SafeDecoder } from '@/modules/contracts/domain/decoders/safe-decoder.helper';
import type { GasTokenFeeService } from '@/modules/relay/domain/gas-token-fee.service';
import { GasTokenRelayError } from '@/modules/relay/domain/errors/gas-token-relay.error';
import { UnofficialMasterCopyError } from '@/modules/relay/domain/errors/unofficial-master-copy.error';
import { GasTokenRelayer } from '@/modules/relay/domain/relayers/gas-token.relayer';
import { safeBuilder } from '@/modules/safe/domain/entities/__tests__/safe.builder';
import type { ISafeRepository } from '@/modules/safe/domain/safe.repository.interface';
import { rawify } from '@/validation/entities/raw.entity';

const mockLoggingService = jest.mocked({
  info: jest.fn(),
} as jest.MockedObjectDeep<ILoggingService>);

const mockSafeRepository = jest.mocked({
  getSafe: jest.fn(),
} as jest.MockedObjectDeep<ISafeRepository>);

const mockFeeService = jest.mocked({
  isEnabled: jest.fn(),
  reserveNativeSpend: jest.fn(),
  getRefundReceiver: jest.fn(),
  getAllowlistedToken: jest.fn(),
  estimateSafeTxGas: jest.fn(),
  simulate: jest.fn(),
  assertRefundCovers: jest.fn(),
} as jest.MockedObjectDeep<GasTokenFeeService>);

const mockRelayApi = jest.mocked({
  relay: jest.fn(),
} as jest.MockedObjectDeep<IRelayApi>);

const mockPublicClient = jest.mocked({
  getCode: jest.fn(),
  getBalance: jest.fn(),
} as jest.MockedObjectDeep<PublicClient>);

const mockBlockchainApiManager = jest.mocked({
  getApi: jest.fn(),
} as jest.MockedObjectDeep<IBlockchainApiManager>);

describe('GasTokenRelayer', () => {
  const chainId = '11155111';
  const version = '1.4.1';
  const safeAddress = getAddress(faker.finance.ethereumAddress());
  const refundReceiver = getAddress(faker.finance.ethereumAddress());
  const usdc = getAddress(faker.finance.ethereumAddress());
  const token = { address: usdc, symbol: 'USDC', decimals: 6, usdPrice: 1 };
  let target: GasTokenRelayer;

  const safePaysData = (): ReturnType<
    ReturnType<typeof execTransactionEncoder>['encode']
  > =>
    execTransactionEncoder()
      .with('safeTxGas', BigInt(80_000))
      .with('baseGas', BigInt(70_000))
      .with('gasPrice', BigInt(60))
      .with('gasToken', usdc)
      .with('refundReceiver', refundReceiver)
      .encode();

  beforeEach(() => {
    jest.resetAllMocks();
    const fakeConfigurationService = new FakeConfigurationService();
    fakeConfigurationService.set('relay.gasToken', { gasLimitBuffer: 50_000 });
    mockSafeRepository.getSafe.mockResolvedValue(safeBuilder().build());
    mockFeeService.isEnabled.mockResolvedValue(true);
    mockFeeService.reserveNativeSpend.mockResolvedValue();
    mockFeeService.getRefundReceiver.mockReturnValue(refundReceiver);
    mockFeeService.getAllowlistedToken.mockReturnValue(token);
    mockFeeService.estimateSafeTxGas.mockResolvedValue(BigInt(50_000));
    mockFeeService.simulate.mockResolvedValue(BigInt(150_000));
    mockFeeService.assertRefundCovers.mockResolvedValue();
    mockBlockchainApiManager.getApi.mockResolvedValue(mockPublicClient);

    target = new GasTokenRelayer(
      mockLoggingService,
      fakeConfigurationService,
      new SafeDecoder(),
      mockSafeRepository,
      mockFeeService,
      mockRelayApi,
      mockBlockchainApiManager,
    );
  });

  describe('getSafePaysFee', () => {
    it('should return the fee fields of a Safe-pays execTransaction', () => {
      expect(target.getSafePaysFee(safePaysData())).toMatchObject({
        value: BigInt(0),
        data: '0x',
        operation: 0,
        safeTxGas: BigInt(80_000),
        baseGas: BigInt(70_000),
        gasPrice: BigInt(60),
        gasToken: usdc,
        refundReceiver,
      });
    });

    it('should return null when the signer pays', () => {
      expect(
        target.getSafePaysFee(execTransactionEncoder().encode()),
      ).toBeNull();
    });

    it('should return null for other calldata', () => {
      expect(target.getSafePaysFee('0xdeadbeef')).toBeNull();
    });
  });

  describe('relay', () => {
    it('should refuse Safe-pays when GAS_TOKEN is disabled without outbound writes', async () => {
      mockFeeService.isEnabled.mockResolvedValue(false);

      await expect(
        target.relay({
          version,
          chainId,
          to: safeAddress,
          data: safePaysData(),
          gasLimit: null,
        }),
      ).rejects.toThrow('not enabled');

      expect(mockSafeRepository.getSafe).not.toHaveBeenCalled();
      expect(mockFeeService.getRefundReceiver).not.toHaveBeenCalled();
      expect(mockFeeService.simulate).not.toHaveBeenCalled();
      expect(mockRelayApi.relay).not.toHaveBeenCalled();
    });

    it('should check, simulate and relay with a buffered gas limit', async () => {
      const taskId = faker.string.uuid();
      mockRelayApi.relay.mockResolvedValue(rawify({ taskId }));
      const data = safePaysData();

      const result = await target.relay({
        version,
        chainId,
        to: safeAddress,
        data,
        gasLimit: null,
      });

      expect(result).toStrictEqual({ taskId });
      expect(mockFeeService.estimateSafeTxGas).toHaveBeenCalledWith({
        chainId,
        safeAddress,
        to: expect.any(String),
        value: '0',
        data: '0x',
        operation: 0,
      });
      expect(mockFeeService.simulate).toHaveBeenCalledWith({
        chainId,
        safeAddress,
        data,
      });
      expect(mockFeeService.assertRefundCovers).toHaveBeenCalledWith({
        chainId,
        token,
        gasPrice: BigInt(60),
        baseGas: BigInt(70_000),
        innerGasEstimate: BigInt(50_000),
        outerGasLimit: BigInt(200_000),
      });
      expect(mockRelayApi.relay).toHaveBeenCalledWith({
        chainId,
        to: safeAddress,
        data,
        gasLimit: BigInt(200_000),
      });
      // ERC-20 refunds go through transfer(): no native receiver or balance checks
      expect(mockBlockchainApiManager.getApi).not.toHaveBeenCalled();
    });

    it('should keep a larger gas limit requested by the caller', async () => {
      mockRelayApi.relay.mockResolvedValue(
        rawify({ taskId: faker.string.uuid() }),
      );

      await target.relay({
        version,
        chainId,
        to: safeAddress,
        data: safePaysData(),
        gasLimit: BigInt(300_000),
      });

      expect(mockRelayApi.relay.mock.calls[0][0].gasLimit).toBe(
        BigInt(300_000),
      );
    });

    it('keeps the reservation when the outbound provider rejects', async () => {
      mockRelayApi.relay.mockRejectedValue(new Error('provider unavailable'));

      await expect(
        target.relay({
          version,
          chainId,
          to: safeAddress,
          data: safePaysData(),
          gasLimit: null,
        }),
      ).rejects.toThrow('provider unavailable');
      expect(mockFeeService.reserveNativeSpend).toHaveBeenCalledWith(
        chainId,
        BigInt(200_000),
      );
    });

    it('should refuse an unofficial Safe', async () => {
      mockSafeRepository.getSafe.mockRejectedValue(new Error('not found'));

      await expect(
        target.relay({
          version,
          chainId,
          to: safeAddress,
          data: safePaysData(),
          gasLimit: null,
        }),
      ).rejects.toThrow(UnofficialMasterCopyError);
      expect(mockRelayApi.relay).not.toHaveBeenCalled();
    });

    it('should refuse a foreign refund receiver', async () => {
      mockFeeService.getRefundReceiver.mockReturnValue(
        getAddress(faker.finance.ethereumAddress()),
      );

      await expect(
        target.relay({
          version,
          chainId,
          to: safeAddress,
          data: safePaysData(),
          gasLimit: null,
        }),
      ).rejects.toThrow('refundReceiver does not match');
      expect(mockRelayApi.relay).not.toHaveBeenCalled();
    });

    it('should refuse a token that is not allowlisted', async () => {
      mockFeeService.getAllowlistedToken.mockReturnValue(null);

      await expect(
        target.relay({
          version,
          chainId,
          to: safeAddress,
          data: safePaysData(),
          gasLimit: null,
        }),
      ).rejects.toThrow('not an accepted fee token');
      expect(mockRelayApi.relay).not.toHaveBeenCalled();
    });

    it('should refuse a safeTxGas below what the call needs', async () => {
      mockFeeService.estimateSafeTxGas.mockResolvedValue(BigInt(80_001));

      await expect(
        target.relay({
          version,
          chainId,
          to: safeAddress,
          data: safePaysData(),
          gasLimit: null,
        }),
      ).rejects.toThrow('safeTxGas 80000 is below the 80001 gas');
      expect(mockRelayApi.relay).not.toHaveBeenCalled();
    });

    it('should refuse a zero safeTxGas, which starves the inner call', async () => {
      mockFeeService.estimateSafeTxGas.mockResolvedValue(BigInt(1));

      await expect(
        target.relay({
          version,
          chainId,
          to: safeAddress,
          data: execTransactionEncoder()
            .with('gasPrice', BigInt(60))
            .with('gasToken', usdc)
            .with('refundReceiver', refundReceiver)
            .encode(),
          gasLimit: null,
        }),
      ).rejects.toThrow('safeTxGas 0 is below');
      expect(mockRelayApi.relay).not.toHaveBeenCalled();
    });

    it('should not relay when the simulation fails', async () => {
      mockFeeService.simulate.mockRejectedValue(
        new GasTokenRelayError('Simulation failed: GS012'),
      );

      await expect(
        target.relay({
          version,
          chainId,
          to: safeAddress,
          data: safePaysData(),
          gasLimit: null,
        }),
      ).rejects.toThrow('GS012');
      expect(mockRelayApi.relay).not.toHaveBeenCalled();
    });

    it('should not relay signer-pays calldata', async () => {
      await expect(
        target.relay({
          version,
          chainId,
          to: safeAddress,
          data: execTransactionEncoder().encode(),
          gasLimit: null,
        }),
      ).rejects.toThrow('Not a Safe-pays execTransaction');
    });
  });
  describe('relay with the native coin', () => {
    const native = { address: zeroAddress, symbol: 'USDC', decimals: 18 };
    const value = parseEther('1');
    const gasPrice = parseGwei('24');
    const baseGas = BigInt(191_600);
    // value + (120k safeTxGas + 191.6k baseGas) × 24 gwei: the contract may charge up to safeTxGas
    const required = value + (BigInt(120_000) + baseGas) * gasPrice;
    const nativeData = (): ReturnType<
      ReturnType<typeof execTransactionEncoder>['encode']
    > =>
      execTransactionEncoder()
        .with('value', value)
        .with('safeTxGas', BigInt(120_000))
        .with('baseGas', baseGas)
        .with('gasPrice', gasPrice)
        .with('gasToken', zeroAddress)
        .with('refundReceiver', refundReceiver)
        .encode();

    beforeEach(() => {
      mockFeeService.getAllowlistedToken.mockReturnValue(native);
      mockPublicClient.getCode.mockResolvedValue(undefined);
      mockPublicClient.getBalance.mockResolvedValue(required);
    });

    it('should check the receiver and balance, then relay', async () => {
      const taskId = faker.string.uuid();
      mockRelayApi.relay.mockResolvedValue(rawify({ taskId }));
      const data = nativeData();

      await expect(
        target.relay({
          version,
          chainId,
          to: safeAddress,
          data,
          gasLimit: null,
        }),
      ).resolves.toStrictEqual({ taskId });

      expect(mockBlockchainApiManager.getApi).toHaveBeenCalledWith(chainId);
      expect(mockPublicClient.getCode).toHaveBeenCalledWith({
        address: refundReceiver,
      });
      expect(mockPublicClient.getBalance).toHaveBeenCalledWith({
        address: safeAddress,
      });
      expect(mockFeeService.assertRefundCovers).toHaveBeenCalledWith({
        chainId,
        token: native,
        gasPrice,
        baseGas,
        innerGasEstimate: BigInt(50_000),
        outerGasLimit: BigInt(200_000),
      });
      expect(mockFeeService.reserveNativeSpend).toHaveBeenCalledWith(
        chainId,
        BigInt(200_000),
      );
      expect(mockRelayApi.relay).toHaveBeenCalledWith({
        chainId,
        to: safeAddress,
        data,
        gasLimit: BigInt(200_000),
      });
    });

    it.each(['0x', undefined])(
      'should treat %s code as an externally owned receiver',
      async (code) => {
        mockPublicClient.getCode.mockResolvedValue(code as `0x${string}`);
        mockRelayApi.relay.mockResolvedValue(
          rawify({ taskId: faker.string.uuid() }),
        );

        await expect(
          target.relay({
            version,
            chainId,
            to: safeAddress,
            data: nativeData(),
            gasLimit: null,
          }),
        ).resolves.toBeDefined();
      },
    );

    it('should refuse a refund receiver with code', async () => {
      mockPublicClient.getCode.mockResolvedValue('0x6080604052');

      await expect(
        target.relay({
          version,
          chainId,
          to: safeAddress,
          data: nativeData(),
          gasLimit: null,
        }),
      ).rejects.toThrow(
        new GasTokenRelayError(
          'The refund receiver is a contract and cannot receive a native refund (GS011)',
        ),
      );
      expect(mockFeeService.reserveNativeSpend).not.toHaveBeenCalled();
      expect(mockRelayApi.relay).not.toHaveBeenCalled();
    });

    it('should refuse a Safe without enough native balance for value and refund', async () => {
      mockPublicClient.getBalance.mockResolvedValue(required - BigInt(1));

      await expect(
        target.relay({
          version,
          chainId,
          to: safeAddress,
          data: nativeData(),
          gasLimit: null,
        }),
      ).rejects.toThrow(
        new GasTokenRelayError(
          `The Safe holds ${required - BigInt(1)} wei of the native coin but needs ${required} for the transaction value and the fee`,
        ),
      );
      expect(mockFeeService.reserveNativeSpend).not.toHaveBeenCalled();
      expect(mockRelayApi.relay).not.toHaveBeenCalled();
    });
  });
});
