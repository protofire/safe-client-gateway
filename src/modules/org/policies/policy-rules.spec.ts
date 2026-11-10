import {
  PolicyRuleSchema,
  PolicyScopeSchema,
} from '@/modules/org/policies/policy-rules';

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

describe('PolicyRuleSchema', () => {
  it('stores addresses and selectors lowercase', () => {
    expect(
      PolicyRuleSchema.parse({
        kind: 'call_allowlist',
        entries: [{ chainId: '1', target: USDC, selectors: ['0xA9059CBB'] }],
      }),
    ).toEqual({
      kind: 'call_allowlist',
      entries: [
        { chainId: '1', target: USDC.toLowerCase(), selectors: ['0xa9059cbb'] },
      ],
    });
    expect(
      PolicyScopeSchema.parse({
        safes: [{ chainId: '1', address: USDC }],
        chainIds: [],
      }).safes[0].address,
    ).toBe(USDC.toLowerCase());
  });

  it('rejects bad selectors, addresses, cap modes, raw amounts and too many caps', () => {
    const cap = {
      chainId: '1',
      token: 'native',
      maxRaw: '1',
      decimals: 18,
      symbol: 'ETH',
    };
    const bad = [
      {
        kind: 'call_allowlist',
        entries: [{ chainId: '1', target: USDC, selectors: ['0xa9059c'] }],
      },
      {
        kind: 'call_allowlist',
        entries: [{ chainId: '1', target: '0x1234', selectors: 'any' }],
      },
      { kind: 'amount_cap', capMode: 'per_day', caps: [cap] },
      {
        kind: 'amount_cap',
        capMode: 'both',
        caps: [{ ...cap, maxRaw: '1.5' }],
      },
      { kind: 'amount_cap', capMode: 'both', caps: [{ ...cap, maxRaw: '-1' }] },
      { kind: 'amount_cap', capMode: 'both', caps: Array(51).fill(cap) },
      { kind: 'recipients_allowlist', tag: 'denied' },
      { kind: 'unknown' },
    ];
    for (const rule of bad)
      expect(PolicyRuleSchema.safeParse(rule).success).toBe(false);
    expect(
      PolicyRuleSchema.safeParse({
        kind: 'amount_cap',
        capMode: 'both',
        caps: [cap],
      }).success,
    ).toBe(true);
  });
});
