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

/** Upload limit for CSV imports (contacts, payout runs). */
export const MAX_CSV_BYTES = 1024 * 1024;
/** Multer limits of every CSV upload: one file and a few short text fields. */
export const CSV_UPLOAD_LIMITS = {
  fileSize: MAX_CSV_BYTES,
  files: 1,
  fields: 4,
  fieldSize: 1024,
  parts: 6,
};

export type CsvRecordError = {
  line: number;
  reason: 'unterminated_quote' | 'stray_quote';
};

/**
 * RFC 4180 records with the physical line each one starts on. A malformed
 * record (quote inside an unquoted field, text after a closing quote, or a
 * quote never closed) is left out of `records` and reported in `errors` with
 * the line its record starts on; an unterminated quote swallows the rest of
 * the file, so it is always the last record.
 */
export function csvRecords(text: string): {
  records: Array<{ line: number; cells: Array<string> }>;
  errors: Array<CsvRecordError>;
} {
  const records: Array<{ line: number; cells: Array<string> }> = [];
  const errors: Array<CsvRecordError> = [];
  let cells: Array<string> = [];
  let cell = '';
  let quoted = false;
  let closed = false; // the current cell had a closing quote
  let stray = false;
  let line = 1;
  let start = 1;
  let touched = false;
  const endRecord = (): void => {
    if (stray) {
      errors.push({ line: start, reason: 'stray_quote' });
    } else if (touched || cell !== '' || cells.length > 0) {
      cells.push(cell);
      records.push({ line: start, cells });
    }
    cells = [];
    cell = '';
    touched = false;
    closed = false;
    stray = false;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
        closed = true;
      } else {
        if (ch === '\n') line++;
        cell += ch;
      }
    } else if (ch === ',') {
      cells.push(cell);
      cell = '';
      closed = false;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      endRecord();
      line++;
      start = line;
    } else if (closed || (ch === '"' && cell !== '')) {
      stray = true;
    } else if (ch === '"') {
      quoted = true;
      touched = true;
    } else {
      cell += ch;
    }
  }
  if (quoted) {
    errors.push({ line: start, reason: 'unterminated_quote' });
  } else {
    endRecord();
  }
  return { records, errors };
}
