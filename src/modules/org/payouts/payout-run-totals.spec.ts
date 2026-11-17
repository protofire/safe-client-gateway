import { runTotals } from '@/modules/org/payouts/payout-runs.service';

const TOKEN = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const MAX = (2n ** 256n - 1n).toString();

describe('runTotals', () => {
  it('sums per token exactly, past Number precision, ordered by token', () => {
    expect(
      runTotals([
        { token: 'native', symbol: 'ETH', decimals: 18, amount_raw: '9007199254740993' },
        { token: TOKEN, symbol: 'USDC', decimals: 6, amount_raw: MAX },
        { token: 'native', symbol: 'ETH', decimals: 18, amount_raw: '1' },
        { token: TOKEN, symbol: 'USDC', decimals: 6, amount_raw: MAX },
      ]),
    ).toEqual([
      {
        token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        symbol: 'USDC',
        decimals: 6,
        amountRaw: (2n * BigInt(MAX)).toString(),
      },
      { token: 'native', symbol: 'ETH', decimals: 18, amountRaw: '9007199254740994' },
    ]);
  });

  it('is empty for a run without rows', () => {
    expect(runTotals([])).toEqual([]);
  });
});
