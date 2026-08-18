import { faker } from '@faker-js/faker';
import { getAddress, toFunctionSelector, type Hex } from 'viem';
import { multisigTransactionBuilder } from '@/modules/safe/domain/entities/__tests__/multisig-transaction.builder';
import { src20TokenBuilder } from '@/modules/tokens/domain/__tests__/token.builder';
import type { AddressInfoHelper } from '@/routes/common/address-info/address-info.helper';
import type { ILoggingService } from '@/logging/logging.interface';
import { AddressInfo } from '@/routes/common/entities/address-info.entity';
import { TransferDirection } from '@/modules/transactions/routes/entities/transfer-transaction-info.entity';
import type { Src20Transfer } from '@/modules/transactions/routes/entities/transfers/src20-transfer.entity';
import { isSrc20Transfer } from '@/modules/transactions/routes/entities/transfers/src20-transfer.entity';
import { Src20TransferMapper } from '@/modules/transactions/routes/mappers/common/src20-transfer.mapper';

const addressInfoHelper = jest.mocked({
  getOrDefault: jest.fn(),
} as jest.MockedObjectDeep<AddressInfoHelper>);

const mockLoggingService = jest.mocked({
  warn: jest.fn(),
} as jest.MockedObjectDeep<ILoggingService>);

// `transfer(address,suint256)` calldata: 4-byte selector + 32-byte word holding the
// left-padded plaintext recipient (the `suint256` amount is omitted/shielded).
function buildSrc20TransferData(recipient: string): Hex {
  const word = recipient.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  return `0xb10c99b5${word}` as Hex;
}

describe('Src20TransferMapper (Unit)', () => {
  let mapper: Src20TransferMapper;

  beforeEach(() => {
    jest.resetAllMocks();
    addressInfoHelper.getOrDefault.mockImplementation((_chainId, address) =>
      Promise.resolve(new AddressInfo(address)),
    );
    mapper = new Src20TransferMapper(addressInfoHelper, mockLoggingService);
  });

  it('the hardcoded selector matches transfer(address,suint256)', () => {
    // Locks the magic constant in transaction-info.mapper.ts to its documented signature.
    // The recipient is a plaintext `address`; only the `suint256` amount is shielded.
    expect(toFunctionSelector('transfer(address,suint256)')).toBe('0xb10c99b5');
  });

  it('maps an outgoing SRC20 transfer with an encrypted value of "0"', async () => {
    const chainId = faker.string.numeric();
    const safe = getAddress(faker.finance.ethereumAddress());
    const recipient = getAddress(faker.finance.ethereumAddress());
    const token = src20TokenBuilder().build();
    const transaction = multisigTransactionBuilder()
      .with('safe', safe)
      .with('to', token.address)
      .with('data', buildSrc20TransferData(recipient))
      .build();

    const result = await mapper.mapSrc20Transfer(
      token,
      chainId,
      transaction,
      null,
    );

    expect(result.direction).toBe(TransferDirection.Outgoing);
    expect(result.sender).toStrictEqual(new AddressInfo(safe));
    expect(result.recipient).toStrictEqual(new AddressInfo(recipient));
    expect(isSrc20Transfer(result.transferInfo)).toBe(true);
    expect(result.transferInfo).toMatchObject({
      tokenAddress: token.address,
      value: '0',
      encrypted: true,
      tokenName: token.name,
      tokenSymbol: token.symbol,
      logoUri: token.logoUri,
      decimals: token.decimals,
      trusted: token.trusted,
    });
  });

  it('never surfaces a non-zero amount regardless of token', async () => {
    const token = src20TokenBuilder().build();
    const transaction = multisigTransactionBuilder()
      .with('safe', token.address)
      .with(
        'data',
        buildSrc20TransferData(getAddress(faker.finance.ethereumAddress())),
      )
      .build();

    const result = await mapper.mapSrc20Transfer(
      token,
      faker.string.numeric(),
      transaction,
      null,
    );

    expect((result.transferInfo as Src20Transfer).value).toBe('0');
    expect((result.transferInfo as Src20Transfer).encrypted).toBe(true);
  });

  it.each([
    ['null data', null],
    ['empty data', '0x' as Hex],
    ['selector only (no recipient word)', '0xb10c99b5' as Hex],
    ['truncated recipient word', `0xb10c99b5${'0'.repeat(40)}` as Hex],
  ])(
    'falls back to the Safe as recipient when calldata is malformed: %s',
    async (_label, data) => {
      const chainId = faker.string.numeric();
      const safe = getAddress(faker.finance.ethereumAddress());
      const token = src20TokenBuilder().build();
      const transaction = multisigTransactionBuilder()
        .with('safe', safe)
        .with('to', token.address)
        .with('data', data as Hex)
        .build();

      const result = await mapper.mapSrc20Transfer(
        token,
        chainId,
        transaction,
        null,
      );

      // Sender === recipient === Safe, so the direction resolves to outgoing.
      expect(result.sender).toStrictEqual(new AddressInfo(safe));
      expect(result.recipient).toStrictEqual(new AddressInfo(safe));
      expect(result.direction).toBe(TransferDirection.Outgoing);
      // The undecodable recipient is logged rather than silently swallowed.
      expect(mockLoggingService.warn).toHaveBeenCalledTimes(1);
    },
  );

  it('passes the human description through unchanged', async () => {
    const humanDescription = faker.lorem.sentence();
    const token = src20TokenBuilder().build();
    const transaction = multisigTransactionBuilder()
      .with(
        'data',
        buildSrc20TransferData(getAddress(faker.finance.ethereumAddress())),
      )
      .build();

    const result = await mapper.mapSrc20Transfer(
      token,
      faker.string.numeric(),
      transaction,
      humanDescription,
    );

    expect(result.humanDescription).toBe(humanDescription);
  });
});
