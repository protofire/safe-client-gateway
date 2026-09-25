import { faker } from '@faker-js/faker';
import { getAddress, type Address } from 'viem';
import {
  addOwnerWithThresholdEncoder,
  execTransactionEncoder,
  swapOwnerEncoder,
} from '@/modules/contracts/domain/__tests__/encoders/safe-encoder.builder';
import {
  erc20ApproveEncoder,
  erc20TransferEncoder,
  erc20TransferFromEncoder,
} from '@/modules/relay/domain/contracts/__tests__/encoders/erc20-encoder.builder';
import {
  multiSendEncoder,
  multiSendTransactionsEncoder,
} from '@/modules/contracts/domain/__tests__/encoders/multi-send-encoder.builder';
import { SafeDecoder } from '@/modules/contracts/domain/decoders/safe-decoder.helper';
import { MultiSendDecoder } from '@/modules/contracts/domain/decoders/multi-send-decoder.helper';
import { Erc20Decoder } from '@/modules/relay/domain/contracts/decoders/erc-20-decoder.helper';
import { ProxyFactoryDecoder } from '@/modules/relay/domain/contracts/decoders/proxy-factory-decoder.helper';
import { DelayModifierDecoder } from '@/modules/alerts/domain/contracts/decoders/delay-modifier-decoder.helper';
import { executeNextTxEncoder } from '@/modules/alerts/domain/contracts/__tests__/encoders/delay-modifier-encoder.builder';
import type { LimitAddressesMapper } from '@/modules/relay/domain/limit-addresses.mapper';
import { NestedRefundError } from '@/modules/relay/domain/errors/nested-refund.error';
import {
  ScreeningAddressesMapper,
  type ScreenedAddress,
} from '@/modules/relay/domain/sanctions/screening-addresses.mapper';
import { safeBuilder } from '@/modules/safe/domain/entities/__tests__/safe.builder';
import type { ISafeRepository } from '@/modules/safe/domain/safe.repository.interface';
import type { ILoggingService } from '@/logging/logging.interface';

const mockLimitAddressesMapper = jest.mocked({
  getLimitAddresses: jest.fn(),
} as jest.MockedObjectDeep<LimitAddressesMapper>);
const mockSafeRepository = jest.mocked({
  getSafe: jest.fn(),
} as jest.MockedObjectDeep<ISafeRepository>);
const mockLoggingService = {
  warn: jest.fn(),
} as jest.MockedObjectDeep<ILoggingService>;

const address = (): Address => getAddress(faker.finance.ethereumAddress());

describe('ScreeningAddressesMapper', () => {
  const chainId = '8453';
  const version = '1.4.1';
  let target: ScreeningAddressesMapper;

  beforeEach(() => {
    jest.resetAllMocks();
    target = new ScreeningAddressesMapper(
      mockLimitAddressesMapper,
      mockSafeRepository,
      new SafeDecoder(),
      new Erc20Decoder(),
      new MultiSendDecoder(mockLoggingService),
      new ProxyFactoryDecoder(),
      new DelayModifierDecoder(),
    );
  });

  it('screens Safe, owners, token and transfer recipient on the Safe-pays path', async () => {
    const safe = safeBuilder().build();
    const token = address();
    const recipient = address();
    mockSafeRepository.getSafe.mockResolvedValue(safe);
    const data = execTransactionEncoder()
      .with('to', token)
      .with('data', erc20TransferEncoder().with('to', recipient).encode())
      .with('gasPrice', BigInt(1))
      .encode();

    const result = await target.map({
      version,
      chainId,
      to: safe.address,
      data,
      isSafePays: true,
    });

    expect(result).toEqual(
      expect.arrayContaining([
        { address: safe.address, role: 'safe' },
        ...safe.owners.map((owner) => ({ address: owner, role: 'owner' })),
        { address: token, role: 'to' },
        { address: recipient, role: 'recipient' },
      ]),
    );
    expect(mockLimitAddressesMapper.getLimitAddresses).not.toHaveBeenCalled();
  });

  it('uses getLimitAddresses on non-Safe-pays paths', async () => {
    const safe = safeBuilder().build();
    mockLimitAddressesMapper.getLimitAddresses.mockResolvedValue([
      safe.address,
    ]);
    mockSafeRepository.getSafe.mockResolvedValue(safe);
    const data = execTransactionEncoder()
      .with('to', address())
      .with('data', '0x')
      .encode();

    const result = await target.map({
      version,
      chainId,
      to: safe.address,
      data,
      isSafePays: false,
    });

    expect(mockLimitAddressesMapper.getLimitAddresses).toHaveBeenCalled();
    expect(result).toEqual(
      expect.arrayContaining([
        { address: safe.address, role: 'safe' },
        ...safe.owners.map((owner) => ({ address: owner, role: 'owner' })),
      ]),
    );
  });

  it('screens the module target, inner Safe target and added owner for a DelayModifier recovery relay', async () => {
    const safe = safeBuilder().build();
    mockLimitAddressesMapper.getLimitAddresses.mockResolvedValue([
      safe.address,
    ]);
    mockSafeRepository.getSafe.mockResolvedValue(safe);
    const newOwner = address();
    const moduleTo = address();
    const innerExec = execTransactionEncoder()
      .with('to', safe.address)
      .with(
        'data',
        addOwnerWithThresholdEncoder().with('owner', newOwner).encode(),
      )
      .with('gasPrice', BigInt(0))
      .encode();
    const batch = multiSendEncoder()
      .with(
        'transactions',
        multiSendTransactionsEncoder([
          {
            operation: 0,
            to: safe.address,
            value: BigInt(0),
            data: innerExec,
          },
        ]),
      )
      .encode();
    const data = executeNextTxEncoder()
      .with('to', moduleTo)
      .with('data', batch)
      .with('operation', 1)
      .encode();

    const result = await target.map({
      version,
      chainId,
      to: address(),
      data,
      isSafePays: false,
    });

    expect(result).toEqual(
      expect.arrayContaining([
        { address: moduleTo, role: 'to' },
        { address: safe.address, role: 'to' },
        { address: newOwner, role: 'recipient' },
      ]),
    );
  });

  it('decodes transferFrom, approve, addOwnerWithThreshold and swapOwner inside MultiSend', async () => {
    const safe = safeBuilder().build();
    mockSafeRepository.getSafe.mockResolvedValue(safe);
    const [from, to, spender, newOwner, swapped] = [
      address(),
      address(),
      address(),
      address(),
      address(),
    ];
    const batch = multiSendEncoder()
      .with(
        'transactions',
        multiSendTransactionsEncoder([
          {
            operation: 0,
            to: address(),
            value: BigInt(0),
            data: erc20TransferFromEncoder()
              .with('sender', from)
              .with('recipient', to)
              .encode(),
          },
          {
            operation: 0,
            to: address(),
            value: BigInt(0),
            data: erc20ApproveEncoder().with('spender', spender).encode(),
          },
          {
            operation: 0,
            to: safe.address,
            value: BigInt(0),
            data: addOwnerWithThresholdEncoder()
              .with('owner', newOwner)
              .encode(),
          },
          {
            operation: 0,
            to: safe.address,
            value: BigInt(0),
            data: swapOwnerEncoder().with('newOwner', swapped).encode(),
          },
        ]),
      )
      .encode();
    const data = execTransactionEncoder()
      .with('to', address())
      .with('data', batch)
      .with('operation', 1)
      .with('gasPrice', BigInt(1))
      .encode();

    const result = await target.map({
      version,
      chainId,
      to: safe.address,
      data,
      isSafePays: true,
    });
    const recipients = result
      .filter((s: ScreenedAddress) => s.role === 'recipient')
      .map((s: ScreenedAddress) => s.address);

    expect(recipients).toEqual(
      expect.arrayContaining([from, to, spender, newOwner, swapped]),
    );
  });

  it('rejects nested execTransaction with gasPrice > 0', async () => {
    const safe = safeBuilder().build();
    mockLimitAddressesMapper.getLimitAddresses.mockResolvedValue([
      safe.address,
    ]);
    mockSafeRepository.getSafe.mockResolvedValue(safe);
    const nested = execTransactionEncoder()
      .with('gasPrice', BigInt(1))
      .encode();
    const data = multiSendEncoder()
      .with(
        'transactions',
        multiSendTransactionsEncoder([
          { operation: 0, to: safe.address, value: BigInt(0), data: nested },
        ]),
      )
      .encode();

    await expect(
      target.map({ version, chainId, to: address(), data, isSafePays: false }),
    ).rejects.toThrow(NestedRefundError);
  });

  it('throws when owners cannot be loaded for an existing Safe', async () => {
    const safe = safeBuilder().build();
    mockSafeRepository.getSafe.mockRejectedValue(new Error('tx-service down'));
    const data = execTransactionEncoder().with('gasPrice', BigInt(1)).encode();

    await expect(
      target.map({
        version,
        chainId,
        to: safe.address,
        data,
        isSafePays: true,
      }),
    ).rejects.toThrow('tx-service down');
  });
});
