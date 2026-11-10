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

  it('rejects duplicates, with the path of the repeated element', () => {
    const lower = USDC.toLowerCase();
    const cap = {
      chainId: '1',
      token: USDC,
      maxRaw: '1',
      decimals: 6,
      symbol: 'USDC',
    };
    const issuePaths = (
      schema: {
        safeParse: (v: unknown) => {
          success: boolean;
          error?: { issues: Array<{ path: Array<PropertyKey> }> };
        };
      },
      v: unknown,
    ): Array<Array<PropertyKey>> => {
      const r = schema.safeParse(v);
      expect(r.success).toBe(false);
      return r.error!.issues.map((i) => i.path);
    };
    expect(
      issuePaths(PolicyRuleSchema, {
        kind: 'call_allowlist',
        entries: [
          {
            chainId: '1',
            target: USDC,
            selectors: ['0xA9059CBB', '0xa9059cbb'],
          },
        ],
      }),
    ).toEqual([['entries', 0, 'selectors', 1]]);
    expect(
      issuePaths(PolicyRuleSchema, {
        kind: 'call_allowlist',
        entries: [
          { chainId: '1', target: USDC, selectors: 'any' },
          { chainId: '10', target: USDC, selectors: 'any' },
          { chainId: '1', target: lower, selectors: ['0xa9059cbb'] },
        ],
      }),
    ).toEqual([['entries', 2]]);
    expect(
      issuePaths(PolicyRuleSchema, {
        kind: 'amount_cap',
        capMode: 'both',
        caps: [cap, { ...cap, token: lower, maxRaw: '2' }],
      }),
    ).toEqual([['caps', 1]]);
    expect(
      issuePaths(PolicyRuleSchema, {
        kind: 'amount_cap',
        capMode: 'both',
        caps: [
          { ...cap, token: 'native' },
          { ...cap, token: 'native' },
        ],
      }),
    ).toEqual([['caps', 1]]);
    expect(
      issuePaths(PolicyScopeSchema, {
        safes: [
          { chainId: '1', address: USDC },
          { chainId: '1', address: lower },
        ],
        chainIds: ['1', '10', '1'],
      }),
    ).toEqual([
      ['safes', 1],
      ['chainIds', 2],
    ]);
    expect(
      PolicyScopeSchema.safeParse({
        safes: [
          { chainId: '1', address: USDC },
          { chainId: '10', address: USDC },
        ],
        chainIds: ['1', '10'],
      }).success,
    ).toBe(true);
  });

  it('caps the selectors of one call_allowlist rule at 2000 in total', () => {
    const entries = (n: number): Array<unknown> =>
      Array.from({ length: n }, (_, i) => ({
        chainId: '1',
        target: `0x${(i + 1).toString(16).padStart(40, '0')}`,
        selectors: Array.from(
          { length: 200 },
          (_, j) => `0x${(j + 1).toString(16).padStart(8, '0')}`,
        ),
      }));
    expect(
      PolicyRuleSchema.safeParse({
        kind: 'call_allowlist',
        entries: entries(10),
      }).success,
    ).toBe(true);
    const over = PolicyRuleSchema.safeParse({
      kind: 'call_allowlist',
      entries: [
        ...entries(10),
        { chainId: '2', target: USDC, selectors: ['0xa9059cbb'] },
      ],
    });
    expect(over.success).toBe(false);
    expect(over.error?.issues[0].path).toEqual(['entries']);
  });
});
