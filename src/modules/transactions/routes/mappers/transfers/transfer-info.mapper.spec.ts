import { faker } from '@faker-js/faker';
import type { TokenRepository } from '@/modules/tokens/domain/token.repository';
import { erc20TransferBuilder } from '@/modules/safe/domain/entities/__tests__/erc20-transfer.builder';
import { erc721TransferBuilder } from '@/modules/safe/domain/entities/__tests__/erc721-transfer.builder';
import { nativeTokenTransferBuilder } from '@/modules/safe/domain/entities/__tests__/native-token-transfer.builder';
import { src20TransferBuilder } from '@/modules/safe/domain/entities/__tests__/src20-transfer.builder';
import { safeBuilder } from '@/modules/safe/domain/entities/__tests__/safe.builder';
import {
  erc20TokenBuilder,
  erc721TokenBuilder,
  src20TokenBuilder,
  tokenBuilder,
} from '@/modules/tokens/domain/__tests__/token.builder';
import type { AddressInfoHelper } from '@/routes/common/address-info/address-info.helper';
import { AddressInfo } from '@/routes/common/entities/address-info.entity';
import {
  TransferTransactionInfo,
  TransferDirection,
} from '@/modules/transactions/routes/entities/transfer-transaction-info.entity';
import { Erc20Transfer } from '@/modules/transactions/routes/entities/transfers/erc20-transfer.entity';
import { Erc721Transfer } from '@/modules/transactions/routes/entities/transfers/erc721-transfer.entity';
import { NativeCoinTransfer } from '@/modules/transactions/routes/entities/transfers/native-coin-transfer.entity';
import { Src20Transfer } from '@/modules/transactions/routes/entities/transfers/src20-transfer.entity';
import { TransferInfoMapper } from '@/modules/transactions/routes/mappers/transfers/transfer-info.mapper';
import { getAddress } from 'viem';
import type { SwapTransferInfoMapper } from '@/modules/transactions/routes/mappers/transfers/swap-transfer-info.mapper';
import type { ILoggingService } from '@/logging/logging.interface';

// Note: we mock this as there is a dedicated test for this mapper
const swapTransferInfoMapper = jest.mocked({
  mapSwapTransferInfo: jest.fn(),
} as jest.MockedObjectDeep<SwapTransferInfoMapper>);

const addressInfoHelper = jest.mocked({
  getOrDefault: jest.fn(),
} as jest.MockedObjectDeep<AddressInfoHelper>);

const tokenRepository = jest.mocked({
  getToken: jest.fn(),
} as jest.MockedObjectDeep<TokenRepository>);

const mockLoggingService = jest.mocked({
  warn: jest.fn(),
} as jest.MockedObjectDeep<ILoggingService>);

describe('Transfer Info mapper (Unit)', () => {
  let mapper: TransferInfoMapper;

  beforeEach(() => {
    jest.resetAllMocks();
    mapper = new TransferInfoMapper(
      tokenRepository,
      swapTransferInfoMapper,
      addressInfoHelper,
      mockLoggingService,
    );
  });

  it('should build an ERC20 TransferTransactionInfo', async () => {
    const chainId = faker.string.numeric();
    const transfer = erc20TransferBuilder().build();
    const safe = safeBuilder().build();
    const addressInfo = new AddressInfo(faker.finance.ethereumAddress());
    const token = erc20TokenBuilder()
      .with('address', getAddress(transfer.tokenAddress))
      .build();
    addressInfoHelper.getOrDefault.mockResolvedValue(addressInfo);
    tokenRepository.getToken.mockResolvedValue(token);

    const actual = await mapper.mapTransferInfo(chainId, transfer, safe);

    expect(actual).toBeInstanceOf(TransferTransactionInfo);
    if (!(actual instanceof TransferTransactionInfo)) {
      throw new Error('Not a TransferTransactionInfo instance');
    }
    expect(actual.transferInfo).toBeInstanceOf(Erc20Transfer);
    expect(actual).toEqual(
      expect.objectContaining({
        sender: addressInfo,
        recipient: addressInfo,
        direction: TransferDirection.Unknown,
        transferInfo: expect.objectContaining({
          type: 'ERC20',
          tokenAddress: transfer.tokenAddress,
          value: transfer.value,
          tokenName: token.name,
          tokenSymbol: token.symbol,
          logoUri: token.logoUri,
          decimals: token.decimals,
        }),
      }),
    );
  });

  it('should build an ERC20 TransferTransactionInfo without token info if fetching it fails', async () => {
    const chainId = faker.string.numeric();
    const transfer = erc20TransferBuilder().build();
    const safe = safeBuilder().build();
    const addressInfo = new AddressInfo(faker.finance.ethereumAddress());
    addressInfoHelper.getOrDefault.mockResolvedValue(addressInfo);
    tokenRepository.getToken.mockRejectedValue(
      new Error('Failed to fetch token'),
    );

    const actual = await mapper.mapTransferInfo(chainId, transfer, safe);

    expect(actual).toBeInstanceOf(TransferTransactionInfo);
    if (!(actual instanceof TransferTransactionInfo)) {
      throw new Error('Not a TransferTransactionInfo instance');
    }
    expect(actual.transferInfo).toBeInstanceOf(Erc20Transfer);
    expect(actual).toEqual(
      expect.objectContaining({
        sender: addressInfo,
        recipient: addressInfo,
        direction: TransferDirection.Unknown,
        transferInfo: expect.objectContaining({
          type: 'ERC20',
          tokenAddress: transfer.tokenAddress,
          value: transfer.value,
          tokenName: null,
          tokenSymbol: null,
          logoUri: null,
          decimals: null,
        }),
      }),
    );
  });

  it('should build an ERC721 TransferTransactionInfo', async () => {
    const chainId = faker.string.numeric();
    const transfer = erc721TransferBuilder().build();
    const safe = safeBuilder().build();
    const addressInfo = new AddressInfo(faker.finance.ethereumAddress());
    const token = erc721TokenBuilder()
      .with('address', getAddress(transfer.tokenAddress))
      .build();
    addressInfoHelper.getOrDefault.mockResolvedValue(addressInfo);
    tokenRepository.getToken.mockResolvedValue(token);

    const actual = await mapper.mapTransferInfo(chainId, transfer, safe);

    expect(actual).toBeInstanceOf(TransferTransactionInfo);
    if (!(actual instanceof TransferTransactionInfo)) {
      throw new Error('Not a TransferTransactionInfo instance');
    }
    expect(actual.transferInfo).toBeInstanceOf(Erc721Transfer);
    expect(actual).toEqual(
      expect.objectContaining({
        sender: addressInfo,
        recipient: addressInfo,
        direction: TransferDirection.Unknown,
        transferInfo: expect.objectContaining({
          type: 'ERC721',
          tokenAddress: transfer.tokenAddress,
          tokenId: transfer.tokenId,
          tokenName: token.name,
          tokenSymbol: token.symbol,
          logoUri: token.logoUri,
        }),
      }),
    );
  });

  it('should build an ERC721 TransferTransactionInfo without token info if fetching it fails', async () => {
    const chainId = faker.string.numeric();
    const transfer = erc721TransferBuilder().build();
    const safe = safeBuilder().build();
    const addressInfo = new AddressInfo(faker.finance.ethereumAddress());
    addressInfoHelper.getOrDefault.mockResolvedValue(addressInfo);
    tokenRepository.getToken.mockRejectedValue(
      new Error('Failed to fetch token'),
    );

    const actual = await mapper.mapTransferInfo(chainId, transfer, safe);

    expect(actual).toBeInstanceOf(TransferTransactionInfo);
    if (!(actual instanceof TransferTransactionInfo)) {
      throw new Error('Not a TransferTransactionInfo instance');
    }
    expect(actual.transferInfo).toBeInstanceOf(Erc721Transfer);
    expect(actual).toEqual(
      expect.objectContaining({
        sender: addressInfo,
        recipient: addressInfo,
        direction: TransferDirection.Unknown,
        transferInfo: expect.objectContaining({
          type: 'ERC721',
          tokenAddress: transfer.tokenAddress,
          tokenId: transfer.tokenId,
          tokenName: null,
          tokenSymbol: null,
          logoUri: null,
        }),
      }),
    );
  });

  it('should build an Native Token TransferTransactionInfo', async () => {
    const chainId = faker.string.numeric();
    const transfer = nativeTokenTransferBuilder().build();
    const safe = safeBuilder().build();
    const addressInfo = new AddressInfo(faker.finance.ethereumAddress());
    const token = tokenBuilder().build();
    addressInfoHelper.getOrDefault.mockResolvedValue(addressInfo);
    tokenRepository.getToken.mockResolvedValue(token);

    const actual = await mapper.mapTransferInfo(chainId, transfer, safe);

    expect(actual).toBeInstanceOf(TransferTransactionInfo);
    if (!(actual instanceof TransferTransactionInfo)) {
      throw new Error('Not a TransferTransactionInfo instance');
    }
    expect(actual.transferInfo).toBeInstanceOf(NativeCoinTransfer);
    expect(actual).toEqual(
      expect.objectContaining({
        sender: addressInfo,
        recipient: addressInfo,
        direction: TransferDirection.Unknown,
        transferInfo: expect.objectContaining({
          type: 'NATIVE_COIN',
          value: transfer.value,
        }),
      }),
    );
  });

  it('should build an SRC20 TransferTransactionInfo', async () => {
    const chainId = faker.string.numeric();
    const transfer = src20TransferBuilder().build();
    const safe = safeBuilder().build();
    const addressInfo = new AddressInfo(faker.finance.ethereumAddress());
    const token = src20TokenBuilder()
      .with('address', getAddress(transfer.tokenAddress))
      .build();
    addressInfoHelper.getOrDefault.mockResolvedValue(addressInfo);
    tokenRepository.getToken.mockResolvedValue(token);

    const actual = await mapper.mapTransferInfo(chainId, transfer, safe);

    expect(actual).toBeInstanceOf(TransferTransactionInfo);
    if (!(actual instanceof TransferTransactionInfo)) {
      throw new Error('Not a TransferTransactionInfo instance');
    }
    expect(actual.transferInfo).toBeInstanceOf(Src20Transfer);
    expect(actual.transferInfo).toMatchObject({
      type: 'SRC20',
      tokenAddress: transfer.tokenAddress,
      tokenName: token.name,
      tokenSymbol: token.symbol,
      logoUri: token.logoUri,
      decimals: token.decimals,
      trusted: token.trusted,
    });
  });

  it('should never surface a non-zero SRC20 amount even if the upstream value is non-zero', async () => {
    // SRC20 amounts are encrypted; the gateway must always report "0" regardless of what
    // the Transaction Service sends, so a real amount can never leak.
    const transfer = src20TransferBuilder().with('value', '123456789').build();
    const safe = safeBuilder().build();
    const token = src20TokenBuilder()
      .with('address', getAddress(transfer.tokenAddress))
      .build();
    addressInfoHelper.getOrDefault.mockResolvedValue(
      new AddressInfo(faker.finance.ethereumAddress()),
    );
    tokenRepository.getToken.mockResolvedValue(token);

    const actual = await mapper.mapTransferInfo(
      faker.string.numeric(),
      transfer,
      safe,
    );

    expect((actual.transferInfo as Src20Transfer).value).toBe('0');
    expect((actual.transferInfo as Src20Transfer).encrypted).toBe(true);
  });

  it('should build an SRC20 TransferTransactionInfo without token info if fetching it fails', async () => {
    const chainId = faker.string.numeric();
    const transfer = src20TransferBuilder().build();
    const safe = safeBuilder().build();
    const addressInfo = new AddressInfo(faker.finance.ethereumAddress());
    addressInfoHelper.getOrDefault.mockResolvedValue(addressInfo);
    tokenRepository.getToken.mockRejectedValue(new Error('Token not found'));

    const actual = await mapper.mapTransferInfo(chainId, transfer, safe);

    expect(actual.transferInfo).toBeInstanceOf(Src20Transfer);
    expect(actual.transferInfo).toMatchObject({
      type: 'SRC20',
      tokenAddress: transfer.tokenAddress,
      value: '0',
      encrypted: true,
      tokenName: null,
      tokenSymbol: null,
      logoUri: null,
      decimals: null,
      trusted: null,
    });
  });
});
