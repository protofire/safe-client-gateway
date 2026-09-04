import { faker } from '@faker-js/faker';
import { getAddress } from 'viem';
import type { Hex } from 'viem';
import { FakeConfigurationService } from '@/config/__tests__/fake.configuration.service';
import { FakeCacheService } from '@/datasources/cache/__tests__/fake.cache.service';
import { HttpErrorFactory } from '@/datasources/errors/http-error-factory';
import { NetworkResponseError } from '@/datasources/network/entities/network.error.entity';
import type { INetworkService } from '@/datasources/network/network.service.interface';
import { DataSourceError } from '@/domain/errors/data-source.error';
import { OzRelayerApi } from '@/modules/relay/datasources/oz-relayer-api.service';
import { RelayStatusCode } from '@/modules/relay/domain/entities/relay-status.entity';
import { rawify } from '@/validation/entities/raw.entity';

const mockNetworkService = jest.mocked({
  get: jest.fn(),
  post: jest.fn(),
} as jest.MockedObjectDeep<INetworkService>);

describe('OzRelayerApi', () => {
  let target: OzRelayerApi;
  let fakeConfigurationService: FakeConfigurationService;
  let baseUri: string;
  let apiKey: string;
  const chainId = '11155111';
  const relayerId = 'sepolia';

  beforeEach(() => {
    jest.resetAllMocks();

    fakeConfigurationService = new FakeConfigurationService();
    baseUri = faker.internet.url({ appendSlash: false });
    apiKey = faker.string.uuid();
    fakeConfigurationService.set('relay.ozRelayer.baseUri', baseUri);
    fakeConfigurationService.set('relay.ozRelayer.apiKey', apiKey);
    fakeConfigurationService.set('relay.ozRelayer.relayerIds', {
      [chainId]: relayerId,
    });

    target = new OzRelayerApi(
      mockNetworkService,
      fakeConfigurationService,
      new HttpErrorFactory(),
      new FakeCacheService(),
    );
  });

  it('should error if the configuration is incomplete', () => {
    expect(
      () =>
        new OzRelayerApi(
          mockNetworkService,
          new FakeConfigurationService(),
          new HttpErrorFactory(),
          new FakeCacheService(),
        ),
    ).toThrow();
  });

  describe('relay', () => {
    it('should post the transaction to the chain relayer with a bearer key', async () => {
      const to = getAddress(faker.finance.ethereumAddress());
      const data = faker.string.hexadecimal() as Hex;
      const taskId = faker.string.uuid();
      mockNetworkService.post.mockResolvedValueOnce({
        status: 200,
        data: rawify({
          success: true,
          data: { id: taskId, status: 'pending' },
        }),
      });

      const result = await target.relay({
        chainId,
        to,
        data,
        gasLimit: BigInt(250_000),
      });

      expect(result).toStrictEqual({ taskId });
      expect(mockNetworkService.post).toHaveBeenCalledWith({
        url: `${baseUri}/api/v1/relayers/${relayerId}/transactions`,
        data: {
          to,
          value: 0,
          data,
          speed: 'fast',
          gas_limit: 250_000,
        },
        networkRequest: { headers: { Authorization: `Bearer ${apiKey}` } },
      });
    });

    it('should omit gas_limit when none is given', async () => {
      mockNetworkService.post.mockResolvedValueOnce({
        status: 200,
        data: rawify({
          success: true,
          data: { id: faker.string.uuid(), status: 'pending' },
        }),
      });

      await target.relay({
        chainId,
        to: getAddress(faker.finance.ethereumAddress()),
        data: faker.string.hexadecimal() as Hex,
        gasLimit: null,
      });

      expect(mockNetworkService.post.mock.calls[0][0].data).not.toHaveProperty(
        'gas_limit',
      );
    });

    it('should refuse chains without a relayer id', async () => {
      await expect(
        target.relay({
          chainId: '1',
          to: getAddress(faker.finance.ethereumAddress()),
          data: faker.string.hexadecimal() as Hex,
          gasLimit: null,
        }),
      ).rejects.toThrow('Relaying is not available on chain 1');
      expect(mockNetworkService.post).not.toHaveBeenCalled();
    });

    it('should surface a relayer rejection', async () => {
      mockNetworkService.post.mockResolvedValueOnce({
        status: 200,
        data: rawify({ success: false, error: 'Insufficient balance' }),
      });

      await expect(
        target.relay({
          chainId,
          to: getAddress(faker.finance.ethereumAddress()),
          data: faker.string.hexadecimal() as Hex,
          gasLimit: null,
        }),
      ).rejects.toThrow('Insufficient balance');
    });

    it('should forward network errors', async () => {
      const status = faker.internet.httpStatusCode({ types: ['serverError'] });
      mockNetworkService.post.mockRejectedValueOnce(
        new NetworkResponseError(new URL(baseUri), { status } as Response, {
          message: 'boom',
        }),
      );

      await expect(
        target.relay({
          chainId,
          to: getAddress(faker.finance.ethereumAddress()),
          data: faker.string.hexadecimal() as Hex,
          gasLimit: null,
        }),
      ).rejects.toThrow(new DataSourceError('boom', status));
    });
  });

  describe('getRelayStatus', () => {
    it.each([
      ['pending', null, RelayStatusCode.Pending],
      ['sent', null, RelayStatusCode.Pending],
      ['submitted', '0xabc', RelayStatusCode.Submitted],
      ['mined', '0xabc', RelayStatusCode.Included],
      ['confirmed', '0xabc', RelayStatusCode.Included],
      ['failed', '0xabc', RelayStatusCode.Reverted],
      ['failed', null, RelayStatusCode.Rejected],
      ['canceled', null, RelayStatusCode.Rejected],
      ['expired', null, RelayStatusCode.Rejected],
    ])('should map %s (hash %s) to %i', async (status, hash, expected) => {
      const taskId = faker.string.uuid();
      mockNetworkService.get.mockResolvedValueOnce({
        status: 200,
        data: rawify({
          success: true,
          data: { id: taskId, status, hash },
        }),
      });

      const result = await target.getRelayStatus({ chainId, taskId });

      expect(result).toStrictEqual({
        status: expected,
        ...(hash && { receipt: { transactionHash: hash } }),
      });
      expect(mockNetworkService.get).toHaveBeenCalledWith({
        url: `${baseUri}/api/v1/relayers/${relayerId}/transactions/${taskId}`,
        networkRequest: { headers: { Authorization: `Bearer ${apiKey}` } },
      });
    });
  });
});
