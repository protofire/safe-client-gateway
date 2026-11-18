import {
  AmountError,
  formatAmount,
  parseAmountStrict,
} from '@/modules/org/common/amounts';

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof AmountError ? e.code : 'not-an-AmountError';
  }
  return undefined;
}

describe('parseAmountStrict', () => {
  it('parses 1000.5 with 6 decimals to 1000500000n', () => {
    expect(parseAmountStrict('1000.5', 6)).toBe(1000500000n);
  });

  it('rejects 1.0000001 with 6 decimals as too_many_decimals', () => {
    expect(code(() => parseAmountStrict('1.0000001', 6))).toBe(
      'too_many_decimals',
    );
  });

  it('parses 7 with 0 decimals and rejects 7.5', () => {
    expect(parseAmountStrict('7', 0)).toBe(7n);
    expect(code(() => parseAmountStrict('7.5', 0))).toBe('too_many_decimals');
  });

  it('parses 1.000000000000000001 with 18 decimals exactly', () => {
    expect(parseAmountStrict('1.000000000000000001', 18)).toBe(10n ** 18n + 1n);
  });

  it.each([
    ['1e3', 'invalid'],
    ['-1', 'invalid'],
    ['1,5', 'invalid'],
    [' 1', 'invalid'],
    ['1 ', 'invalid'],
    ['+1', 'invalid'],
    ['.5', 'invalid'],
    ['1.', 'invalid'],
    ['', 'invalid'],
    ['0x10', 'invalid'],
    ['0', 'zero'],
    ['0.000', 'zero'],
  ])('rejects 1e3, -1, 1,5, " 1", 0 and 0.000 (%j)', (value, expected) => {
    expect(code(() => parseAmountStrict(value, 6))).toBe(expected);
  });

  it('rejects 2^256 raw as overflow', () => {
    const max = 2n ** 256n - 1n;
    expect(parseAmountStrict(max.toString(), 0)).toBe(max);
    expect(code(() => parseAmountStrict((max + 1n).toString(), 0))).toBe(
      'overflow',
    );
    expect(code(() => parseAmountStrict('1', 78))).toBe('overflow');
  });

  it('rejects a 101-character amount before calling BigInt', () => {
    const spy = jest.spyOn(global, 'BigInt');
    expect(code(() => parseAmountStrict('1'.repeat(101), 0))).toBe('invalid');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    expect(parseAmountStrict('0'.repeat(99) + '1', 0)).toBe(1n);
  });

  it('rejects a decimals value that is not a non-negative integer', () => {
    expect(code(() => parseAmountStrict('1', -1))).toBe('invalid');
    expect(code(() => parseAmountStrict('1', 1.5))).toBe('invalid');
  });

  it.each([
    ['1', 0],
    ['1000.5', 6],
    ['0.000001', 6],
    ['123456789.123456789123456789', 18],
    ['1.000000000000000001', 18],
    ['42', 18],
  ])(
    'formatAmount(parseAmountStrict(x, d), d) round-trips for listed values (%s, %d)',
    (value, decimals) => {
      expect(formatAmount(parseAmountStrict(value, decimals), decimals)).toBe(
        value,
      );
    },
  );

  it('formats without trailing zeros or exponent', () => {
    expect(formatAmount(1000500000n, 6)).toBe('1000.5');
    expect(formatAmount(10n ** 30n, 6)).toBe('1000000000000000000000000');
    expect(formatAmount(1n, 18)).toBe('0.000000000000000001');
    expect(formatAmount(0n, 6)).toBe('0');
  });
});
