import { createHash } from 'node:crypto';
import type { Address } from 'viem';
import { configHash } from '@/modules/org/policies/config-hash';
import type {
  PolicyRule,
  PolicyScope,
} from '@/modules/org/policies/policy-rules';

const A = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as Address;
const B = '0xdAC17F958D2ee523a2206206994597C13D831ec7' as Address;

const scope: PolicyScope = {
  safes: [
    { chainId: '1', address: B },
    { chainId: '1', address: A },
    { chainId: '10', address: A },
  ],
  chainIds: ['137', '10'],
};
const rules: Array<PolicyRule> = [
  { kind: 'no_delegatecall' },
  {
    kind: 'call_allowlist',
    entries: [
      { chainId: '1', target: B, selectors: ['0xA9059CBB', '0x095ea7b3'] },
      { chainId: '1', target: A, selectors: 'any' },
    ],
  },
  {
    kind: 'amount_cap',
    capMode: 'both',
    caps: [
      {
        chainId: '1',
        token: A,
        maxRaw: '1000000',
        decimals: 6,
        symbol: 'USDC',
      },
      {
        chainId: '1',
        token: 'native',
        maxRaw: '10',
        decimals: 18,
        symbol: 'ETH',
      },
    ],
  },
  { kind: 'recipients_allowlist', tag: 'allowed' },
];

const lower = (a: Address): Address => a.toLowerCase() as Address;

describe('configHash', () => {
  it('is a sha256 hex of the canonical JSON', () => {
    const empty = configHash({ safes: [], chainIds: [] }, []);
    expect(empty).toBe(
      createHash('sha256')
        .update('{"rules":[],"scope":{"chainIds":[],"safes":[]}}')
        .digest('hex'),
    );
  });

  it('is equal for the same rules in different key and address case order', () => {
    const reKeyed: Array<PolicyRule> = [
      { kind: 'no_delegatecall' },
      {
        entries: [
          {
            selectors: ['0x095EA7B3', '0xa9059cbb'],
            target: lower(B),
            chainId: '1',
          },
          { selectors: 'any', chainId: '1', target: lower(A) },
        ],
        kind: 'call_allowlist',
      },
      {
        caps: [
          {
            symbol: 'USDC',
            decimals: 6,
            maxRaw: '1000000',
            token: lower(A),
            chainId: '1',
          },
          {
            token: 'native',
            chainId: '1',
            symbol: 'ETH',
            maxRaw: '10',
            decimals: 18,
          },
        ],
        capMode: 'both',
        kind: 'amount_cap',
      },
      { tag: 'allowed', kind: 'recipients_allowlist' },
    ];
    const lowerScope: PolicyScope = {
      chainIds: scope.chainIds,
      safes: scope.safes.map((s) => ({
        address: lower(s.address),
        chainId: s.chainId,
      })),
    };
    expect(configHash(lowerScope, reKeyed)).toBe(configHash(scope, rules));
  });

  it('is equal for reordered scope safes, scope chainIds and rules', () => {
    const reordered: PolicyScope = {
      safes: [...scope.safes].reverse(),
      chainIds: [...scope.chainIds].reverse(),
    };
    const rulesReordered = [...rules].reverse().map((r) => {
      if (r.kind === 'call_allowlist')
        return { ...r, entries: [...r.entries].reverse() };
      if (r.kind === 'amount_cap') return { ...r, caps: [...r.caps].reverse() };
      return r;
    });
    expect(configHash(reordered, rulesReordered)).toBe(
      configHash(scope, rules),
    );
  });

  it('changes when a cap changes by 1 wei', () => {
    const bumped = rules.map((r) =>
      r.kind === 'amount_cap'
        ? {
            ...r,
            caps: r.caps.map((c) =>
              c.token === 'native' ? { ...c, maxRaw: '11' } : c,
            ),
          }
        : r,
    );
    expect(configHash(scope, bumped)).not.toBe(configHash(scope, rules));
  });

  it('changes with the cap mode and the scope', () => {
    const perTx = rules.map((r) =>
      r.kind === 'amount_cap'
        ? { ...r, capMode: 'per_transaction' as const }
        : r,
    );
    expect(configHash(scope, perTx)).not.toBe(configHash(scope, rules));
    expect(configHash({ ...scope, chainIds: ['137'] }, rules)).not.toBe(
      configHash(scope, rules),
    );
  });
});
