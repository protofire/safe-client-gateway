import { isAddress, zeroAddress } from 'viem';
import { csvRecords } from '@/modules/org/common/csv';

export const MAX_PAYOUT_ROWS = 500;
export const MAX_PAYOUT_TOKENS = 20;
export const PAYOUT_NAME_MAX = 64;

export type PayoutCsvRow = {
  line: number;
  address: string;
  amount: string;
  /** 'native' or a lowercase token address */
  token: string;
  name?: string;
};
export type PayoutCsvError = { line: number; reason: string };

const REQUIRED = ['address', 'amount', 'token'];

/** All-lowercase, all-uppercase hex, or a valid EIP-55 checksum. */
function isStrictAddress(value: string): boolean {
  const hex = value.slice(2);
  return isAddress(hex === hex.toUpperCase() ? value.toLowerCase() : value, {
    strict: true,
  });
}

/**
 * Parses a payout CSV (`address,amount,token[,name]`, header case-insensitive,
 * extra columns ignored). Only the shape is checked here; amounts are parsed
 * against token decimals by the caller (`parseAmountStrict`). Token symbols
 * are never looked up: the token column is `native`, empty, or an address.
 */
export function parsePayoutCsv(text: string): {
  rows: Array<PayoutCsvRow>;
  errors: Array<PayoutCsvError>;
} {
  const parsed = csvRecords(text.startsWith('﻿') ? text.slice(1) : text);
  const errors: Array<PayoutCsvError> = [...parsed.errors];
  const [head, ...records] = parsed.records;
  const names = head?.cells.map((c) => c.trim().toLowerCase()) ?? [];
  const [iAddress, iAmount, iToken] = REQUIRED.map((h) => names.indexOf(h));
  const iName = names.indexOf('name');
  if (!head || iAddress < 0 || iAmount < 0 || iToken < 0) {
    return {
      rows: [],
      errors: [...errors, { line: head?.line ?? 1, reason: 'invalid_header' }],
    };
  }
  const body = records.filter(
    ({ cells }) => !(cells.length === 1 && cells[0].trim() === ''),
  );
  // malformed records count too: they are data rows the user sent
  const errorLines = parsed.errors.filter((e) => e.line > head.line);
  if (body.length + errorLines.length > MAX_PAYOUT_ROWS) {
    const lines = [
      ...body.map((r) => r.line),
      ...errorLines.map((e) => e.line),
    ];
    lines.sort((a, b) => a - b);
    return {
      rows: [],
      errors: [{ line: lines[MAX_PAYOUT_ROWS], reason: 'too_many_rows' }],
    };
  }
  const rows: Array<PayoutCsvRow> = [];
  const tokens = new Set<string>();
  for (const { line, cells } of body) {
    const cell = (i: number): string => (i < 0 ? '' : (cells[i] ?? '').trim());
    const address = cell(iAddress);
    const amount = cell(iAmount);
    const rawToken = cell(iToken);
    const name = cell(iName);
    const token =
      rawToken === '' || rawToken.toLowerCase() === 'native'
        ? 'native'
        : rawToken.toLowerCase();
    let reason: string | null = null;
    if (!isStrictAddress(address) || address.toLowerCase() === zeroAddress) {
      reason = 'invalid_address';
    } else if (amount === '') {
      reason = 'missing_amount';
    } else if (token !== 'native' && !isStrictAddress(rawToken)) {
      reason = 'invalid_token';
    } else if (name.length > PAYOUT_NAME_MAX) {
      reason = 'name_too_long';
    } else if (!tokens.has(token) && tokens.size >= MAX_PAYOUT_TOKENS) {
      reason = 'too_many_tokens';
    }
    if (reason) {
      errors.push({ line, reason });
      continue;
    }
    tokens.add(token);
    rows.push({ line, address, amount, token, ...(name ? { name } : {}) });
  }
  errors.sort((a, b) => a.line - b.line);
  return { rows, errors };
}
