import { sumDecimals } from '@/modules/org/safes/decimal';

describe('sumDecimals', () => {
  it('adds without float error', () => {
    expect(sumDecimals(['0.1', '0.2'])).toBe('0.3');
    expect(sumDecimals([])).toBe('0');
    expect(sumDecimals(['1234567890123.456789', '1'])).toBe(
      '1234567890124.456789',
    );
  });

  it('handles exponent notation and negatives', () => {
    expect(sumDecimals(['1e-7', '1'])).toBe('1.0000001');
    expect(sumDecimals(['-1.5', '0.5'])).toBe('-1');
  });
});
