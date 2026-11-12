export type AmountErrorCode =
  | 'too_many_decimals'
  | 'invalid'
  | 'zero'
  | 'overflow';

export class AmountError extends Error {
  constructor(readonly code: AmountErrorCode) {
    super(code);
  }
}

const MAX_AMOUNT_LENGTH = 100;
const MAX_DECIMALS = 255; // ERC20 decimals is a uint8
const UINT256_LIMIT = 2n ** 256n;

/**
 * Decimal string → raw integer units, exact. Never rounds: more fractional
 * digits than `decimals` (trailing zeros included) is an error. Use this, not
 * viem `parseUnits` (rounds) or `safes/decimal.ts` (accepts exponents).
 */
export function parseAmountStrict(amount: string, decimals: number): bigint {
  // length first, so BigInt never sees an unbounded string
  if (
    amount.length > MAX_AMOUNT_LENGTH ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > MAX_DECIMALS
  ) {
    throw new AmountError('invalid');
  }
  const match = /^(\d+)(?:\.(\d+))?$/.exec(amount);
  if (!match) throw new AmountError('invalid');
  const fraction = match[2] ?? '';
  if (fraction.length > decimals) throw new AmountError('too_many_decimals');
  const raw = BigInt(match[1] + fraction.padEnd(decimals, '0'));
  if (raw === 0n) throw new AmountError('zero');
  if (raw >= UINT256_LIMIT) throw new AmountError('overflow');
  return raw;
}

/** Raw units → decimal string without trailing zeros or exponent. */
export function formatAmount(raw: bigint, decimals: number): string {
  const digits = raw.toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}
