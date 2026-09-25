import { faker } from '@faker-js/faker';
import { getAddress } from 'viem';
import { FakeConfigurationService } from '@/config/__tests__/fake.configuration.service';
import type { INetworkService } from '@/datasources/network/network.service.interface';
import type { ILoggingService } from '@/logging/logging.interface';
import { SanctionsListService } from '@/modules/relay/domain/sanctions/sanctions-list.service';

const mockNetworkService = jest.mocked({
  get: jest.fn(),
} as jest.MockedObjectDeep<INetworkService>);
const mockLoggingService = jest.mocked({
  warn: jest.fn(),
} as jest.MockedObjectDeep<ILoggingService>);

const listed = faker.finance.ethereumAddress().toLowerCase();
const clean = faker.finance.ethereumAddress().toLowerCase();
const url = 'https://lists.example/sanctioned-evm/latest.json';
const now = Date.parse('2026-09-25T12:00:00Z');

function list(overrides: Record<string, unknown> = {}): unknown {
  return {
    schema: 1,
    sourceSha256: 'a'.repeat(64),
    sourcePublishDate: 'Wed, 24 Sep 2026 14:00:00 GMT',
    generatedAt: '2026-09-25T11:00:00.000Z',
    checkedAt: '2026-09-25T11:00:00.000Z',
    count: 1,
    addresses: [listed],
    ...overrides,
  };
}

function service(
  sanctions: Record<string, unknown>,
  isProduction = false,
): SanctionsListService {
  const config = new FakeConfigurationService();
  config.set('application.isProduction', isProduction);
  config.set('relay.sanctions', {
    listUrl: url,
    maxStalenessHours: 48,
    extraAddresses: [],
    ...sanctions,
  });
  return new SanctionsListService(
    config,
    mockNetworkService,
    mockLoggingService,
  );
}

describe('SanctionsListService', () => {
  beforeEach(() => jest.resetAllMocks());

  it('refuses to start in production without a list URL', () => {
    expect(() => service({ listUrl: undefined }, true)).toThrow();
  });

  it('refuses extra addresses in production', () => {
    expect(() => service({ extraAddresses: [clean] }, true)).toThrow();
  });

  it('is disabled without a URL outside production', () => {
    expect(service({ listUrl: undefined }).isEnabled()).toBe(false);
  });

  it('is unavailable before the first successful load', () => {
    expect(service({}).check([getAddress(clean)], now).result).toBe(
      'unavailable',
    );
  });

  it('hits checksummed input against a lower-case list', async () => {
    mockNetworkService.get.mockResolvedValue({
      status: 200,
      data: list(),
    } as never);
    const target = service({});
    await target.refresh();
    const result = target.check([getAddress(clean), getAddress(listed)], now);
    expect(result.result).toBe('hit');
    expect(result.matches).toEqual([getAddress(listed)]);
    expect(result.list?.sourceSha256).toBe('a'.repeat(64));
  });

  it('is clear when nothing matches', async () => {
    mockNetworkService.get.mockResolvedValue({
      status: 200,
      data: list(),
    } as never);
    const target = service({});
    await target.refresh();
    expect(target.check([getAddress(clean)], now).result).toBe('clear');
  });

  it('is unavailable when checkedAt is older than the staleness limit', async () => {
    mockNetworkService.get.mockResolvedValue({
      status: 200,
      data: list({ checkedAt: '2026-09-23T11:59:59.000Z' }),
    } as never);
    const target = service({});
    await target.refresh();
    expect(target.check([getAddress(clean)], now).result).toBe('unavailable');
  });

  it('keeps last good list on invalid payload', async () => {
    mockNetworkService.get.mockResolvedValueOnce({
      status: 200,
      data: list(),
    } as never);
    mockNetworkService.get.mockResolvedValueOnce({
      status: 200,
      data: { schema: 1 },
    } as never);
    const target = service({});
    await target.refresh();
    await target.refresh();
    expect(target.check([getAddress(listed)], now).result).toBe('hit');
    expect(mockLoggingService.warn).toHaveBeenCalledTimes(1);
  });

  it('rejects a list whose count does not match its addresses', async () => {
    mockNetworkService.get.mockResolvedValue({
      status: 200,
      data: list({ count: 2 }),
    } as never);
    const target = service({});
    await target.refresh();
    expect(target.check([getAddress(listed)], now).result).toBe('unavailable');
  });

  it('merges extra addresses outside production', async () => {
    mockNetworkService.get.mockResolvedValue({
      status: 200,
      data: list(),
    } as never);
    const target = service({ extraAddresses: [clean] });
    await target.refresh();
    expect(target.check([getAddress(clean)], now).result).toBe('hit');
  });
});
