import { isAddress } from 'viem';
import { csvRecords } from '@/modules/org/common/csv';

export type SafeCsvRow = {
  line: number;
  address: string;
  name: string;
  chainId: string;
};
export type SafeCsvError = { line: number; reason: string };

const HEADER = ['address', 'name', 'chainId'];
const NAME_MAX = 64;

/**
 * Parses the Safe{Wallet} address book export (`address,name,chainId`; extra
 * columns are ignored). Invalid lines, malformed quoting included, are
 * reported, never thrown.
 */
export function parseSafeAddressBookCsv(text: string): {
  rows: Array<SafeCsvRow>;
  errors: Array<SafeCsvError>;
} {
  const rows: Array<SafeCsvRow> = [];
  const parsed = csvRecords(text.startsWith('\uFEFF') ? text.slice(1) : text);
  const errors: Array<SafeCsvError> = [...parsed.errors];
  const [head, ...body] = parsed.records;
  const names = head?.cells.map((c) => c.trim().toLowerCase());
  const index = HEADER.map((h) => names?.indexOf(h.toLowerCase()) ?? -1);
  if (!head || index.some((i) => i < 0)) {
    return {
      rows,
      errors: [
        ...errors,
        {
          line: head?.line ?? 1,
          reason: 'Header must be address,name,chainId',
        },
      ],
    };
  }
  for (const { line, cells } of body) {
    const [address, name, chainId] = index.map((i) => (cells[i] ?? '').trim());
    if (cells.length === 1 && cells[0].trim() === '') continue;
    if (!isAddress(address, { strict: true })) {
      errors.push({ line, reason: 'Invalid address' });
    } else if (name.length < 1 || name.length > NAME_MAX) {
      errors.push({ line, reason: `Name must be 1-${NAME_MAX} characters` });
    } else if (!/^[1-9]\d{0,17}$/.test(chainId)) {
      errors.push({ line, reason: 'Invalid chainId' });
    } else {
      rows.push({ line, address, name, chainId });
    }
  }
  errors.sort((a, b) => a.line - b.line);
  return { rows, errors };
}
