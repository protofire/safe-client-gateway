import { csvRecords, guardFormula } from '@/modules/org/common/csv';
import { parseSafeAddressBookCsv } from '@/modules/org/address-book/safe-csv.parser';
import { parsePayoutCsv } from '@/modules/org/payouts/payout-csv.parser';

const A = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';

describe('guardFormula', () => {
  it.each(['=1+1', '+1', '-1', '@x', '\tx', '\rx'])('prefixes %j', (v) => {
    expect(guardFormula(v)).toBe(`'${v}`);
  });

  it.each(['plain', '', 'a=b', "'=x"])('keeps %j', (v) => {
    expect(guardFormula(v)).toBe(v);
  });
});

describe('csvRecords', () => {
  it('reports an unterminated quote with the line its record starts on', () => {
    const { records, errors } = csvRecords('a,b\n1,2\n3,"x\n4,5\n');
    expect(records).toEqual([
      { line: 1, cells: ['a', 'b'] },
      { line: 2, cells: ['1', '2'] },
    ]);
    expect(errors).toEqual([{ line: 3, reason: 'unterminated_quote' }]);
  });

  it('keeps line numbers across quoted newlines', () => {
    const { records, errors } = csvRecords(
      'a,b\r\n"multi\r\nline\nvalue",1\r\n"say ""hi""",2\r\nlast,3',
    );
    expect(errors).toEqual([]);
    expect(records).toEqual([
      { line: 1, cells: ['a', 'b'] },
      { line: 2, cells: ['multi\r\nline\nvalue', '1'] },
      { line: 5, cells: ['say "hi"', '2'] },
      { line: 6, cells: ['last', '3'] },
    ]);
  });

  it('reports a stray quote inside an unquoted field and after a closing quote', () => {
    const { records, errors } = csvRecords('a,b\nab"c,1\n"ab"c,2\n"ok",3\n');
    expect(errors).toEqual([
      { line: 2, reason: 'stray_quote' },
      { line: 3, reason: 'stray_quote' },
    ]);
    expect(records).toEqual([
      { line: 1, cells: ['a', 'b'] },
      { line: 4, cells: ['ok', '3'] },
    ]);
  });

  it('reports the stray-quote line errors through both parsers', () => {
    const contacts = parseSafeAddressBookCsv(
      `address,name,chainId\n${A},Ac"me,1\n${A},"Acme"x,1\n${A},Ok,1`,
    );
    expect(contacts.errors).toEqual([
      { line: 2, reason: 'stray_quote' },
      { line: 3, reason: 'stray_quote' },
    ]);
    expect(contacts.rows.map((r) => r.line)).toEqual([4]);

    const payouts = parsePayoutCsv(
      `address,amount,token\n${A},1"0,native\n${A},"1"0,native\n${A},1,native`,
    );
    expect(payouts.errors).toEqual([
      { line: 2, reason: 'stray_quote' },
      { line: 3, reason: 'stray_quote' },
    ]);
    expect(payouts.rows.map((r) => r.line)).toEqual([4]);
  });

  it('reports the unterminated-quote line error through both parsers', () => {
    const contacts = parseSafeAddressBookCsv(
      `address,name,chainId\n${A},Ok,1\n${A},"Acme,1\n${A},Lost,1`,
    );
    expect(contacts.errors).toEqual([
      { line: 3, reason: 'unterminated_quote' },
    ]);
    expect(contacts.rows.map((r) => r.line)).toEqual([2]);

    const payouts = parsePayoutCsv(
      `address,amount,token\n${A},1,native\n${A},"1,native\n${A},2,native`,
    );
    expect(payouts.errors).toEqual([{ line: 3, reason: 'unterminated_quote' }]);
    expect(payouts.rows.map((r) => r.line)).toEqual([2]);
  });
});
