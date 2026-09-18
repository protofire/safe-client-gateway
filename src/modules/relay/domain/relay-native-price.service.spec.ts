import { RelayNativePriceService } from './relay-native-price.service';
import { FakeConfigurationService } from '@/config/__tests__/fake.configuration.service';
import { chainBuilder } from '@/modules/chains/domain/entities/__tests__/chain.builder';
import type { INetworkService } from '@/datasources/network/network.service.interface';
import { rawify } from '@/validation/entities/raw.entity';

describe('RelayNativePriceService', () => {
  const chain = chainBuilder().build();
  const coin = chain.pricesProvider.nativeCoin!;
  const network = { get: jest.fn() } as unknown as jest.Mocked<INetworkService>;
  let service: RelayNativePriceService;
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(1_000_000);
    jest.resetAllMocks();
    const config = new FakeConfigurationService();
    config.set(
      'balances.providers.safe.prices.baseUri',
      'https://prices.example',
    );
    service = new RelayNativePriceService(config, network);
    network.get.mockResolvedValue({
      status: 200,
      data: rawify({ [coin]: { usd: 2500 } }),
    });
  });
  afterEach(() => jest.useRealTimers());

  it('reuses a fresh price without extending its timestamp, then refreshes', async () => {
    const first = await service.getPrice(chain);
    jest.advanceTimersByTime(99_999);
    expect(await service.getPrice(chain)).toEqual(first);
    expect(network.get).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    network.get.mockResolvedValue({
      status: 200,
      data: rawify({ [coin]: { usd: 2600 } }),
    });
    expect(await service.getPrice(chain)).toEqual({
      usd: 2600,
      fetchedAt: 1_100_000,
    });
  });

  it('survives an outage for at most five minutes from acquisition, including repeated failures', async () => {
    const first = await service.getPrice(chain);
    network.get.mockRejectedValue(new Error('unavailable'));
    jest.advanceTimersByTime(100_000);
    expect(await service.getPrice(chain)).toEqual(first);
    jest.advanceTimersByTime(199_999);
    expect(await service.getPrice(chain)).toEqual(first);
    jest.advanceTimersByTime(1);
    expect(await service.getPrice(chain)).toBeNull();
    network.get.mockResolvedValue({
      status: 200,
      data: rawify({ [coin]: { usd: 2700 } }),
    });
    expect(await service.getPrice(chain)).toEqual({
      usd: 2700,
      fetchedAt: 1_300_000,
    });
  });

  it.each([0, -1, '2500', null])(
    'rejects invalid prices (%s), including on a cold cache',
    async (usd) => {
      network.get.mockResolvedValue({
        status: 200,
        data: rawify({ [coin]: { usd } }),
      });
      expect(await service.getPrice(chain)).toBeNull();
    },
  );

  it('coalesces concurrent requests for the same native coin across chains', async () => {
    const prices = await Promise.all([
      service.getPrice(chain),
      service.getPrice({ ...chain, chainId: '8453' }),
    ]);
    expect(network.get).toHaveBeenCalledTimes(1);
    expect(prices[0]).toEqual(prices[1]);
  });

  it('does not use a price for another native coin', async () => {
    await service.getPrice(chain);
    network.get.mockRejectedValue(new Error('unavailable'));
    expect(
      await service.getPrice({
        ...chain,
        pricesProvider: { ...chain.pricesProvider, nativeCoin: 'another-coin' },
      }),
    ).toBeNull();
  });

  it('does not extend fallback lifetime while a request is in flight', async () => {
    await service.getPrice(chain);
    jest.advanceTimersByTime(299_000);
    network.get.mockImplementation(() => {
      jest.advanceTimersByTime(2000);
      return Promise.reject(new Error('timeout'));
    });
    expect(await service.getPrice(chain)).toBeNull();
  });
});
