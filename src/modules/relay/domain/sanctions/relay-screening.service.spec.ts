import { faker } from '@faker-js/faker';
import { getAddress, keccak256 } from 'viem';
import type { ILoggingService } from '@/logging/logging.interface';
import type { SanctionsListService } from '@/modules/relay/domain/sanctions/sanctions-list.service';
import { ScreeningAddressesMapper } from '@/modules/relay/domain/sanctions/screening-addresses.mapper';
import { RelayScreeningService } from '@/modules/relay/domain/sanctions/relay-screening.service';
import {
  SanctionsListUnavailableError,
  SanctionsScreeningError,
} from '@/modules/relay/domain/errors/sanctions-screening.error';
import { NestedRefundError } from '@/modules/relay/domain/errors/nested-refund.error';
import type { LimitAddressesMapper } from '@/modules/relay/domain/limit-addresses.mapper';
import type { ISafeRepository } from '@/modules/safe/domain/safe.repository.interface';
import { safeBuilder } from '@/modules/safe/domain/entities/__tests__/safe.builder';
import { SafeDecoder } from '@/modules/contracts/domain/decoders/safe-decoder.helper';
import { MultiSendDecoder } from '@/modules/contracts/domain/decoders/multi-send-decoder.helper';
import { Erc20Decoder } from '@/modules/relay/domain/contracts/decoders/erc-20-decoder.helper';
import { ProxyFactoryDecoder } from '@/modules/relay/domain/contracts/decoders/proxy-factory-decoder.helper';
import { DelayModifierDecoder } from '@/modules/alerts/domain/contracts/decoders/delay-modifier-decoder.helper';
import { execTransactionEncoder } from '@/modules/contracts/domain/__tests__/encoders/safe-encoder.builder';
import { erc20TransferEncoder } from '@/modules/relay/domain/contracts/__tests__/encoders/erc20-encoder.builder';
import {
  multiSendEncoder,
  multiSendTransactionsEncoder,
} from '@/modules/contracts/domain/__tests__/encoders/multi-send-encoder.builder';

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
    mockMapper.map.mockResolvedValue({
      screened: [
        { address: owner, role: 'owner' },
        { address: owner, role: 'recipient' },
      ],
      transfers: [],
    });
    target = new RelayScreeningService(mockList, mockMapper, mockLogging);
  });

  it('skips everything but the nested-refund guard when screening is disabled', async () => {
    mockList.isEnabled.mockReturnValue(false);
    await expect(target.screen(args)).resolves.toBe('disabled');
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
    await expect(target.screen(args)).resolves.toEqual({
      result: 'clear',
      list,
    });
    expect(mockList.check).toHaveBeenCalledWith([owner]);
    expect(mockLogging.info).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'SANCTIONS_SCREENING',
        result: 'clear',
        dataHash: keccak256(args.data),
        list,
      }),
    );
    // Clear events stay their old size: transfer details are for refused hits only
    expect(mockLogging.info.mock.calls[0][0]).not.toHaveProperty('transfers');
  });

  describe('with the real mapper', () => {
    const safe = safeBuilder().build();
    const realTarget = (): RelayScreeningService =>
      new RelayScreeningService(
        mockList,
        new ScreeningAddressesMapper(
          {} as LimitAddressesMapper,
          {
            getSafe: jest.fn().mockResolvedValue(safe),
          } as unknown as ISafeRepository,
          new SafeDecoder(),
          new Erc20Decoder(),
          new MultiSendDecoder(mockLogging),
          new ProxyFactoryDecoder(),
          new DelayModifierDecoder(),
        ),
        mockLogging,
      );
    const execBatch = (
      transactions: Parameters<typeof multiSendTransactionsEncoder>[0],
    ): typeof args =>
      ({
        ...args,
        to: safe.address,
        data: execTransactionEncoder()
          .with('to', getAddress(faker.finance.ethereumAddress()))
          .with(
            'data',
            multiSendEncoder()
              .with('transactions', multiSendTransactionsEncoder(transactions))
              .encode(),
          )
          .with('operation', 1)
          .with('gasPrice', BigInt(1))
          .encode(),
      }) as typeof args;

    it('adds native and ERC-20 transfers of a MultiSend to a hit event', async () => {
      const [payee, token] = [
        getAddress(faker.finance.ethereumAddress()),
        getAddress(faker.finance.ethereumAddress()),
      ];
      mockList.check.mockReturnValue({ result: 'hit', matches: [owner], list });

      await expect(
        realTarget().screen(
          execBatch([
            { operation: 0, to: payee, value: BigInt(7), data: '0x' },
            {
              operation: 0,
              to: token,
              value: BigInt(0),
              data: erc20TransferEncoder()
                .with('to', owner)
                .with('value', BigInt(100))
                .encode(),
            },
          ]),
        ),
      ).rejects.toBeInstanceOf(SanctionsScreeningError);

      expect(mockLogging.warn.mock.calls[0][0]).toMatchObject({
        type: 'SANCTIONS_SCREENING',
        result: 'hit',
        transfers: [
          { token: null, from: safe.address, to: payee, amount: '7' },
          { token, from: safe.address, to: owner, amount: '100' },
        ],
        transfersTotal: 2,
      });
    });

    it('caps the logged transfers at 100 and reports the total', async () => {
      mockList.check.mockReturnValue({ result: 'hit', matches: [owner], list });
      const payee = getAddress(faker.finance.ethereumAddress());

      await realTarget()
        .screen(
          execBatch(
            Array.from({ length: 150 }, () => ({
              operation: 0,
              to: payee,
              value: BigInt(1),
              data: '0x' as const,
            })),
          ),
        )
        .catch(() => undefined);

      const event = mockLogging.warn.mock.calls[0][0] as {
        transfers: Array<unknown>;
        transfersTotal: number;
      };
      expect(event.transfers).toHaveLength(100);
      expect(event.transfersTotal).toBe(150);
    });
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
