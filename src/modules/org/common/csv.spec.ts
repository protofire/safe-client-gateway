import { guardFormula } from '@/modules/org/common/csv';

describe('guardFormula', () => {
  it.each(['=1+1', '+1', '-1', '@x', '\tx', '\rx'])('prefixes %j', (v) => {
    expect(guardFormula(v)).toBe(`'${v}`);
  });

  it.each(['plain', '', 'a=b', "'=x"])('keeps %j', (v) => {
    expect(guardFormula(v)).toBe(v);
  });
});
