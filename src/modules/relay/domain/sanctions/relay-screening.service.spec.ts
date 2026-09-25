import { faker } from '@faker-js/faker';
import { getAddress, keccak256 } from 'viem';
import type { ILoggingService } from '@/logging/logging.interface';
import type { SanctionsListService } from '@/modules/relay/domain/sanctions/sanctions-list.service';
import type { ScreeningAddressesMapper } from '@/modules/relay/domain/sanctions/screening-addresses.mapper';
import { RelayScreeningService } from '@/modules/relay/domain/sanctions/relay-screening.service';
import {
  SanctionsListUnavailableError,
  SanctionsScreeningError,
} from '@/modules/relay/domain/errors/sanctions-screening.error';
import { NestedRefundError } from '@/modules/relay/domain/errors/nested-refund.error';

const mockList = jest.mocked({
  isEnabled: jest.fn(),
  check: jest.fn(),
} as jest.MockedObjectDeep<SanctionsListService>);
const mockMapper = jest.mocked({
  map: jest.fn(),
  assertNoNestedRefund: jest.fn(),
} as jest.MockedObjectDeep<ScreeningAddressesMapper>);
const mockLogging = jest.mocked({
  info: jest.fn(),
  warn: jest.fn(),
} as jest.MockedObjectDeep<ILoggingService>);

describe('RelayScreeningService', () => {
  const owner = getAddress(faker.finance.ethereumAddress());
  const args = {
    version: '1.4.1',
    chainId: '8453',
    to: getAddress(faker.finance.ethereumAddress()),
    data: '0x1234' as const,
    isSafePays: true,
  };
  const list = {
    sourceSha256: 'a'.repeat(64),
    sourcePublishDate: 'x',
    checkedAt: '2026-09-25T11:00:00.000Z',
  };
  let target: RelayScreeningService;

  beforeEach(() => {
    jest.resetAllMocks();
    mockList.isEnabled.mockReturnValue(true);
    mockMapper.map.mockResolvedValue([
      { address: owner, role: 'owner' },
      { address: owner, role: 'recipient' },
    ]);
    target = new RelayScreeningService(mockList, mockMapper, mockLogging);
  });

  it('skips everything but the nested-refund guard when screening is disabled', async () => {
    mockList.isEnabled.mockReturnValue(false);
    await target.screen(args);
    expect(mockMapper.map).not.toHaveBeenCalled();
    expect(mockMapper.assertNoNestedRefund).toHaveBeenCalledWith(args.data);
  });

  it('still rejects a nested refund when screening is disabled', async () => {
    mockList.isEnabled.mockReturnValue(false);
    mockMapper.assertNoNestedRefund.mockImplementation(() => {
      throw new NestedRefundError();
    });
    await expect(target.screen(args)).rejects.toThrow(
      'A transaction that refunds the executor must be relayed on its own, not inside a batch.',
    );
  });

  it('logs a clear check with list version and dataHash, and returns', async () => {
    mockList.check.mockReturnValue({ result: 'clear', matches: [], list });
    await target.screen(args);
    expect(mockList.check).toHaveBeenCalledWith([owner]);
    expect(mockLogging.info).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'SANCTIONS_SCREENING',
        result: 'clear',
        dataHash: keccak256(args.data),
        list,
      }),
    );
  });

  it('throws 403 without details on a hit and logs a warning', async () => {
    mockList.check.mockReturnValue({ result: 'hit', matches: [owner], list });
    const error = await target.screen(args).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SanctionsScreeningError);
    expect((error as SanctionsScreeningError).getStatus()).toBe(403);
    expect((error as Error).message).not.toContain(owner);
    expect(mockLogging.warn).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'hit', matches: [owner] }),
    );
  });

  it('throws 503 when the list is unavailable', async () => {
    mockList.check.mockReturnValue({
      result: 'unavailable',
      matches: [],
      list: null,
    });
    await expect(target.screen(args)).rejects.toBeInstanceOf(
      SanctionsListUnavailableError,
    );
  });
});
