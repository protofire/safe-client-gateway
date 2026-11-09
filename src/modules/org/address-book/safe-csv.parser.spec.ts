import { parseSafeAddressBookCsv } from '@/modules/org/address-book/safe-csv.parser';

const A = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';

describe('parseSafeAddressBookCsv', () => {
  it('parses rows, quotes, CRLF and BOM, and reports bad lines with reasons', () => {
    const text =
      '﻿address,name,chainId\r\n' +
      `${A},"Acme, ""Inc""",1\r\n` +
      `0x123,Short,1\r\n` +
      `${A},,1\r\n` +
      `${A},Name,abc\r\n` +
      '\r\n' +
      `${A.toLowerCase()},Lower,137\r\n`;
    const { rows, errors } = parseSafeAddressBookCsv(text);
    expect(rows).toEqual([
      { address: A, name: 'Acme, "Inc"', chainId: '1' },
      { address: A.toLowerCase(), name: 'Lower', chainId: '137' },
    ]);
    expect(errors).toEqual([
      { line: 3, reason: 'Invalid address' },
      { line: 4, reason: expect.stringContaining('Name') },
      { line: 5, reason: 'Invalid chainId' },
    ]);
  });

  it('rejects a bad checksum and a missing header', () => {
    const bad = A.slice(0, -1) + 'E';
    expect(
      parseSafeAddressBookCsv(`address,name,chainId\n${bad},X,1`).errors,
    ).toEqual([{ line: 2, reason: 'Invalid address' }]);
    expect(parseSafeAddressBookCsv('foo,bar\n1,2').errors).toHaveLength(1);
    expect(parseSafeAddressBookCsv('').errors).toHaveLength(1);
  });
});
