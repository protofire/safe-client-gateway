import { faker } from '@faker-js/faker';
import { getAddress } from 'viem';
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
  getRefundReceiver: jest.fn(),
  getAllowlistedToken: jest.fn(),
  simulate: jest.fn(),
  assertRefundCovers: jest.fn(),
} as jest.MockedObjectDeep<GasTokenFeeService>);

const mockRelayApi = jest.mocked({
  relay: jest.fn(),
} as jest.MockedObjectDeep<IRelayApi>);

describe('GasTokenRelayer', () => {
  const chainId = '11155111';
  const version = '1.4.1';
  const safeAddress = getAddress(faker.finance.ethereumAddress());
  const refundReceiver = getAddress(faker.finance.ethereumAddress());
  const usdc = getAddress(faker.finance.ethereumAddress());
  const token = { address: usdc, decimals: 6, usdPrice: 1 };
  let target: GasTokenRelayer;

  const safePaysData = (): ReturnType<
    ReturnType<typeof execTransactionEncoder>['encode']
  > =>
    execTransactionEncoder()
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
    mockFeeService.getRefundReceiver.mockReturnValue(refundReceiver);
    mockFeeService.getAllowlistedToken.mockReturnValue(token);
    mockFeeService.simulate.mockResolvedValue(BigInt(150_000));
    mockFeeService.assertRefundCovers.mockResolvedValue();

    target = new GasTokenRelayer(
      mockLoggingService,
      fakeConfigurationService,
      new SafeDecoder(),
      mockSafeRepository,
      mockFeeService,
      mockRelayApi,
    );
  });

  describe('getSafePaysFee', () => {
    it('should return the fee fields of a Safe-pays execTransaction', () => {
      expect(target.getSafePaysFee(safePaysData())).toStrictEqual({
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
        gasEstimate: BigInt(150_000),
      });
      expect(mockRelayApi.relay).toHaveBeenCalledWith({
        chainId,
        to: safeAddress,
        data,
        gasLimit: BigInt(200_000),
      });
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
});
