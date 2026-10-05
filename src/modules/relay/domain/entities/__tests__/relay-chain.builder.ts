import { faker } from '@faker-js/faker';
import { getAddress } from 'viem';
import type { IBuilder } from '@/__tests__/builder';
import { Builder } from '@/__tests__/builder';
import type { RelayChain } from '@/modules/relay/domain/entities/gas-token.configuration';

export function relayChainBuilder(): IBuilder<RelayChain> {
  return new Builder<RelayChain>()
    .with('relayerId', faker.string.alphanumeric({ length: 12 }))
    .with(
      'nativeUsdPrice',
      faker.number.float({ min: 1, max: 5_000, fractionDigits: 2 }),
    )
    .with('refundReceiver', getAddress(faker.finance.ethereumAddress()))
    .with('payFromSafeDailyBudgetWei', null)
    .with('sponsoringDailyBudgetWei', '100000000000000000')
    .with('sponsoringPerSafePerDay', faker.number.int({ min: 1, max: 100 }))
    .with(
      'sponsoringPerOwnerCreationsPerDay',
      faker.number.int({ min: 0, max: 20 }),
    )
    .with('sponsoringMaxGasLimit', 1_500_000)
    .with('tokens', [
      {
        address: getAddress(faker.finance.ethereumAddress()),
        symbol: 'USDC',
        decimals: 6,
        usdPrice: 1,
      },
    ]);
}
