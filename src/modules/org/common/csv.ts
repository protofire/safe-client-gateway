import type { RateLimiter } from '@/modules/org/common/rate-limiter';

/**
 * Spreadsheet formula-injection guard: a cell starting with = + - @ TAB or CR
 * is prefixed with `'` so Excel/Sheets read it as text. Plug into the gateway
 * CsvService via the csv-stringify `cast` option; RFC 4180 quoting stays with
 * csv-stringify.
 */
export function guardFormula(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

export const csvCast = { string: guardFormula };

// Activity and contacts exports share one budget: each streams a whole table (item 7)
const EXPORTS_PER_USER_PER_HOUR = 20;

export function limitExports(
  rateLimiter: RateLimiter,
  userId: string,
): Promise<void> {
  return rateLimiter.enforce(
    `exports:user:${userId}`,
    EXPORTS_PER_USER_PER_HOUR,
    3600,
  );
}
