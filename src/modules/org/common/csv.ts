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
