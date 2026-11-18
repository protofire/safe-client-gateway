const SCALE = 18;

function toScaled(value: string): bigint {
  // fiat strings can come out of float formatting, e.g. "1e-7"
  const plain = /e/i.test(value) ? Number(value).toFixed(SCALE) : value;
  const negative = plain.startsWith('-');
  const [whole, frac = ''] = plain.replace('-', '').split('.');
  const scaled =
    BigInt(whole || '0') * 10n ** BigInt(SCALE) +
    BigInt(frac.slice(0, SCALE).padEnd(SCALE, '0'));
  return negative ? -scaled : scaled;
}

/** Exact decimal sum of non-negative or signed decimal strings; no floats. */
export function sumDecimals(values: ReadonlyArray<string>): string {
  const total = values.reduce((acc, v) => acc + toScaled(v), 0n);
  const negative = total < 0n;
  const abs = (negative ? -total : total).toString().padStart(SCALE + 1, '0');
  const whole = abs.slice(0, -SCALE);
  const frac = abs.slice(-SCALE).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}
