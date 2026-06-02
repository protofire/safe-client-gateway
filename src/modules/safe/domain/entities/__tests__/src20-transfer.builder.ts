import { faker } from '@faker-js/faker';
import type { IBuilder } from '@/__tests__/builder';
import { Builder } from '@/__tests__/builder';
import type { SRC20Transfer } from '@/modules/safe/domain/entities/transfer.entity';
import { type Address, getAddress } from 'viem';

export function src20TransferBuilder(): IBuilder<SRC20Transfer> {
  return new Builder<SRC20Transfer>()
    .with('type', 'SRC20_TRANSFER')
    .with('blockNumber', faker.number.int())
    .with('executionDate', faker.date.recent())
    .with('from', getAddress(faker.finance.ethereumAddress()))
    .with('to', getAddress(faker.finance.ethereumAddress()))
    .with('transactionHash', faker.string.hexadecimal() as Address)
    .with('tokenAddress', getAddress(faker.finance.ethereumAddress()))
    .with('value', faker.string.numeric())
    .with('transferId', faker.string.sample());
}

export function toJson(src20Transfer: SRC20Transfer): unknown {
  return {
    ...src20Transfer,
    executionDate: src20Transfer.executionDate.toISOString(),
  };
}
