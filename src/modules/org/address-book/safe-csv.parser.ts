import { isAddress } from 'viem';

export type SafeCsvRow = { address: string; name: string; chainId: string };
export type SafeCsvError = { line: number; reason: string };

const HEADER = ['address', 'name', 'chainId'];
const NAME_MAX = 64;

/** RFC 4180 records with the physical line each one starts on. */
function records(text: string): Array<{ line: number; cells: Array<string> }> {
  const out: Array<{ line: number; cells: Array<string> }> = [];
  let cells: Array<string> = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let start = 1;
  let touched = false;
  const endRecord = (): void => {
    if (touched || cell !== '' || cells.length > 0) {
      cells.push(cell);
      out.push({ line: start, cells });
    }
    cells = [];
    cell = '';
    touched = false;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        if (ch === '\n') line++;
        cell += ch;
      }
    } else if (ch === '"' && cell === '') {
      quoted = true;
      touched = true;
    } else if (ch === ',') {
      cells.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      endRecord();
      line++;
      start = line;
    } else {
      cell += ch;
    }
  }
  endRecord();
  return out;
}

/**
 * Parses the Safe{Wallet} address book export (`address,name,chainId`; extra
 * columns are ignored). Invalid lines are reported, never thrown.
 */
export function parseSafeAddressBookCsv(text: string): {
  rows: Array<SafeCsvRow>;
  errors: Array<SafeCsvError>;
} {
  const rows: Array<SafeCsvRow> = [];
  const errors: Array<SafeCsvError> = [];
  const [head, ...body] = records(
    text.startsWith('\uFEFF') ? text.slice(1) : text,
  );
  const names = head?.cells.map((c) => c.trim().toLowerCase());
  const index = HEADER.map((h) => names?.indexOf(h.toLowerCase()) ?? -1);
  if (!head || index.some((i) => i < 0)) {
    return {
      rows,
      errors: [
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
      rows.push({ address, name, chainId });
    }
  }
  return { rows, errors };
}
