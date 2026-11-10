import { getAddress } from 'viem';
import { parsePayoutCsv } from '@/modules/org/payouts/payout-csv.parser';

const A = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

function addr(i: number): string {
  return getAddress(`0x${(i + 1).toString(16).padStart(40, '0')}`);
}

describe('parsePayoutCsv', () => {
  it('parses the four columns with BOM and CRLF', () => {
    const text =
      '\uFEFFAddress,Amount,Token,Name,Extra\r\n' +
      `${A},1000.5,${USDC},"Alice, Inc",x\r\n` +
      `${A},0.1,native,,x\r\n` +
      '\r\n';
    expect(parsePayoutCsv(text)).toEqual({
      rows: [
        {
          line: 2,
          address: A.toLowerCase(),
          amount: '1000.5',
          token: USDC.toLowerCase(),
          name: 'Alice, Inc',
        },
        { line: 3, address: A.toLowerCase(), amount: '0.1', token: 'native' },
      ],
      errors: [],
    });
  });

  it('maps empty token and "native" to native', () => {
    const { rows, errors } = parsePayoutCsv(
      `address,amount,token\n${A},1,\n${A},2,NATIVE\n${A},3, native `,
    );
    expect(errors).toEqual([]);
    expect(rows.map((r) => r.token)).toEqual(['native', 'native', 'native']);
  });

  it('reports the line number of a row with a missing amount', () => {
    const { rows, errors } = parsePayoutCsv(
      `address,amount,token\n${A},1,native\n${A},,native\n${A}`,
    );
    expect(errors).toEqual([
      { line: 3, reason: 'missing_amount' },
      { line: 4, reason: 'missing_amount' },
    ]);
    expect(rows.map((r) => r.line)).toEqual([2]);
  });

  it('reports invalid and zero recipient addresses', () => {
    const { errors } = parsePayoutCsv(
      `address,amount,token\n0x123,1,native\n0x0000000000000000000000000000000000000000,1,native`,
    );
    expect(errors).toEqual([
      { line: 2, reason: 'invalid_address' },
      { line: 3, reason: 'invalid_address' },
    ]);
  });

  it('rejects a missing header column', () => {
    expect(parsePayoutCsv(`address,amount\n${A},1`).errors).toEqual([
      { line: 1, reason: 'invalid_header' },
    ]);
    expect(parsePayoutCsv('').errors).toEqual([
      { line: 1, reason: 'invalid_header' },
    ]);
  });

  it('rejects 501 rows', () => {
    const body = (n: number): string =>
      Array.from({ length: n }, () => `${A},1,native`).join('\n');
    expect(parsePayoutCsv(`address,amount,token\n${body(500)}`).errors).toEqual(
      [],
    );
    expect(parsePayoutCsv(`address,amount,token\n${body(501)}`)).toEqual({
      rows: [],
      errors: [{ line: 502, reason: 'too_many_rows' }],
    });
  });

  it('rejects a 21st distinct token on its line', () => {
    const lines = [`${A},1,native`];
    for (let i = 0; i < 19; i++) lines.push(`${A},1,${addr(i)}`);
    lines.push(`${A},1,${addr(0).toLowerCase()}`); // repeat, any case
    lines.push(`${A},1,${addr(19)}`); // 21st distinct
    lines.push(`${A},1,native`); // seen
    const { rows, errors } = parsePayoutCsv(
      `address,amount,token\n${lines.join('\n')}`,
    );
    expect(errors).toEqual([{ line: 23, reason: 'too_many_tokens' }]);
    expect(rows).toHaveLength(22);
  });

  it('rejects a token symbol and a bad-checksum address as invalid_token', () => {
    const bad = USDC.slice(0, -1) + 'E';
    const { errors } = parsePayoutCsv(
      `address,amount,token\n${A},1,USDC\n${A},1,${bad}\n${A},1,${USDC.toUpperCase().replace('0X', '0x')}`,
    );
    expect(errors).toEqual([
      { line: 2, reason: 'invalid_token' },
      { line: 3, reason: 'invalid_token' },
    ]);
  });

  it('rejects a name over 64 characters', () => {
    const { rows, errors } = parsePayoutCsv(
      `address,amount,token,name\n${A},1,native,${'x'.repeat(65)}\n${A},1,native,${'y'.repeat(64)}`,
    );
    expect(errors).toEqual([{ line: 2, reason: 'name_too_long' }]);
    expect(rows.map((r) => r.line)).toEqual([3]);
  });

  it('reports a row with more cells than the header as too_many_cells', () => {
    const { rows, errors } = parsePayoutCsv(
      `address,token,amount\n${A},native,1,000\n${A},native,1`,
    );
    expect(errors).toEqual([{ line: 2, reason: 'too_many_cells' }]);
    expect(rows.map((r) => r.line)).toEqual([3]);
  });

  it('rejects duplicate header names as invalid_header', () => {
    expect(
      parsePayoutCsv(`address,amount,token,Amount\n${A},1,native,2`).errors,
    ).toEqual([{ line: 1, reason: 'invalid_header' }]);
  });

  it('accepts uppercase hex, rejects a 0X prefix and returns addresses lowercased', () => {
    const upper = '0x' + A.slice(2).toUpperCase();
    const { rows, errors } = parsePayoutCsv(
      `address,amount,token\n${upper},1,${'0x' + USDC.slice(2).toUpperCase()}\n0X${A.slice(2).toLowerCase()},1,native\n${A},1,0X${USDC.slice(2).toLowerCase()}`,
    );
    expect(rows).toEqual([
      {
        line: 2,
        address: A.toLowerCase(),
        amount: '1',
        token: USDC.toLowerCase(),
      },
    ]);
    expect(errors).toEqual([
      { line: 3, reason: 'invalid_address' },
      { line: 4, reason: 'invalid_token' },
    ]);
  });

  it('rejects the zero address as token', () => {
    expect(
      parsePayoutCsv(
        `address,amount,token\n${A},1,0x0000000000000000000000000000000000000000`,
      ).errors,
    ).toEqual([{ line: 2, reason: 'invalid_token' }]);
  });

  it.each(['Al\u0000ice', 'Bob\u200b', 'Eve\u202e', 'Tab\tbed'])(
    'rejects a name with control or format characters (%j)',
    (name) => {
      expect(
        parsePayoutCsv(`address,amount,token,name\n${A},1,native,${name}`)
          .errors,
      ).toEqual([{ line: 2, reason: 'invalid_name' }]);
    },
  );
});
