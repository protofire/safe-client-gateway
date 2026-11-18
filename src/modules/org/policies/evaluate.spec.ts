import {
  encodeFunctionData,
  erc20Abi,
  getAddress,
  parseAbi,
  type Address,
} from 'viem';
import type { SafeCall } from '@/modules/org/common/multisend';
import {
  multiSendCall,
  multiSendData,
  packCalls,
} from '@/modules/org/common/__tests__/multisend.builder';
import { evaluate, type EvalContext } from '@/modules/org/policies/evaluate';
import type {
  CompiledPolicy,
  PolicyRule,
} from '@/modules/org/policies/policy-rules';

const addr = (n: number): Address =>
  getAddress(`0x${n.toString(16).padStart(40, '0')}`);
const SAFE = addr(0x5afe);
const MULTISEND = addr(0x3e5d);
const ALLOWED = addr(0xa11);
const STRANGER = addr(0xbad);
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as Address; // checksummed
const OTHER = addr(0xc0de);

const ctx: EvalContext = {
  chainId: '1',
  allowedRecipients: new Set([ALLOWED.toLowerCase()]),
  trustedMultiSend: new Set([MULTISEND.toLowerCase()]),
};

const allowanceAbi = parseAbi(['function increaseAllowance(address,uint256)']);
const send = (to: Address, value: bigint): SafeCall => ({
  to,
  value,
  data: '0x',
  operation: 0,
});
const erc20 = (
  fn: 'transfer' | 'approve',
  to: Address,
  amount: bigint,
  token: Address = USDC,
): SafeCall => ({
  to: token,
  value: 0n,
  data: encodeFunctionData({
    abi: erc20Abi,
    functionName: fn,
    args: [to, amount],
  }),
  operation: 0,
});
const transferFrom = (to: Address, amount: bigint): SafeCall => ({
  to: USDC,
  value: 0n,
  data: encodeFunctionData({
    abi: erc20Abi,
    functionName: 'transferFrom',
    args: [SAFE, to, amount],
  }),
  operation: 0,
});
const increaseAllowance = (spender: Address, amount: bigint): SafeCall => ({
  to: USDC,
  value: 0n,
  data: encodeFunctionData({
    abi: allowanceAbi,
    functionName: 'increaseAllowance',
    args: [spender, amount],
  }),
  operation: 0,
});
const delegate = (to: Address): SafeCall => ({
  to,
  value: 0n,
  data: '0x12345678',
  operation: 1,
});
const ms = (calls: ReadonlyArray<SafeCall>): SafeCall =>
  multiSendCall(MULTISEND, calls);

let seq = 0;
const policy = (...rules: Array<PolicyRule>): CompiledPolicy => ({
  id: `p${++seq}`,
  name: `policy ${seq}`,
  version: 1,
  configHash: 'h',
  rules,
});
const allowlist: PolicyRule = { kind: 'recipients_allowlist', tag: 'allowed' };
const cap = (
  capMode: 'per_transfer' | 'per_transaction' | 'both',
  maxRaw: string,
  token: string = USDC.toLowerCase(),
  chainId = '1',
): PolicyRule => ({
  kind: 'amount_cap',
  capMode,
  caps: [
    {
      chainId,
      token: token as Address | 'native',
      maxRaw,
      decimals: 6,
      symbol: 'USDC',
    },
  ],
});
const rulesOf = (r: ReturnType<typeof evaluate>): Array<[string, string]> =>
  r.status === 'ok' ? [] : r.violations.map((v) => [v.rule, v.callPath]);

describe('evaluate', () => {
  it('is ok for an allowed native send and an allowed ERC20 transfer in one MultiSend', () => {
    const tx = ms([send(ALLOWED, 5n), erc20('transfer', ALLOWED, 7n)]);
    expect(evaluate([policy(allowlist, cap('both', '100'))], tx, ctx)).toEqual({
      status: 'ok',
    });
  });

  it('flags the unknown recipient of call 2 with callPath "2"', () => {
    const tx = ms([
      send(ALLOWED, 1n),
      erc20('transfer', ALLOWED, 1n),
      erc20('transfer', STRANGER, 1n),
    ]);
    const p = policy(allowlist);
    const r = evaluate([p], tx, ctx);
    expect(r).toEqual({
      status: 'violation',
      violations: [
        {
          policyId: p.id,
          policyVersion: 1,
          rule: 'recipients_allowlist',
          callPath: '2',
          to: USDC,
          detail: expect.stringContaining(STRANGER.toLowerCase()),
        },
      ],
    });
  });

  it('checks a top-level transfer with callPath ""', () => {
    expect(
      rulesOf(evaluate([policy(allowlist)], send(STRANGER, 1n), ctx)),
    ).toEqual([['recipients_allowlist', '']]);
  });

  it('reports a delegatecall inside a MultiSend to a non-MultiSend target as undecodable for a policy with only an amount cap', () => {
    const r = evaluate(
      [policy(cap('per_transfer', '100'))],
      ms([send(ALLOWED, 1n), delegate(OTHER)]),
      ctx,
    );
    expect(r).toEqual({
      status: 'violation',
      violations: [
        expect.objectContaining({
          rule: 'undecodable',
          callPath: '1',
          to: OTHER,
          detail: 'delegatecall',
        }),
      ],
    });
  });

  it('reports a top-level delegatecall to a non-MultiSend target as undecodable and as no_delegatecall where that rule is set', () => {
    const plain = policy(allowlist);
    const strict = policy({ kind: 'no_delegatecall' });
    const r = evaluate([plain, strict], delegate(OTHER), ctx);
    expect(
      r.status === 'violation' &&
        r.violations.map((v) => [v.policyId, v.rule, v.callPath, v.detail]),
    ).toEqual([
      [plain.id, 'undecodable', '', 'delegatecall'],
      [strict.id, 'undecodable', '', 'delegatecall'],
      [strict.id, 'no_delegatecall', '', expect.any(String)],
    ]);
  });

  it('reports nothing for a policy without rules', () => {
    expect(evaluate([policy()], delegate(OTHER), ctx)).toEqual({
      status: 'ok',
    });
  });

  it('does not report no_delegatecall for a trusted MultiSend', () => {
    expect(
      evaluate(
        [policy({ kind: 'no_delegatecall' })],
        ms([send(ALLOWED, 1n)]),
        ctx,
      ),
    ).toEqual({ status: 'ok' });
  });

  it('unpacks a nested MultiSend and reports callPath "1.0"', () => {
    const tx = ms([
      send(ALLOWED, 1n),
      ms([send(STRANGER, 1n), send(ALLOWED, 1n)]),
    ]);
    expect(rulesOf(evaluate([policy(allowlist)], tx, ctx))).toEqual([
      ['recipients_allowlist', '1.0'],
    ]);
  });

  it('reports nesting_too_deep at depth 3', () => {
    const depth2 = ms([ms([send(ALLOWED, 1n)])]);
    expect(evaluate([policy(allowlist)], depth2, ctx)).toEqual({
      status: 'ok',
    });
    const depth3 = ms([ms([ms([send(ALLOWED, 1n)])])]);
    expect(rulesOf(evaluate([policy(allowlist)], depth3, ctx))).toEqual([
      ['nesting_too_deep', '0.0'],
    ]);
  });

  it('treats undecodable MultiSend data as a violation, never ok', () => {
    const trailing: SafeCall = {
      to: MULTISEND,
      value: 0n,
      data: multiSendData(`${packCalls([send(ALLOWED, 1n)])}00`),
      operation: 1,
    };
    const selectorOnly: SafeCall = {
      to: MULTISEND,
      value: 0n,
      data: '0x8d80ff0a',
      operation: 1,
    };
    for (const tx of [
      trailing,
      selectorOnly,
      ms([send(ALLOWED, 1n), selectorOnly]),
    ]) {
      const r = evaluate([policy(cap('per_transfer', '1'))], tx, ctx);
      expect(r.status).toBe('violation');
      expect(rulesOf(r).map(([rule]) => rule)).toEqual(['undecodable']);
    }
  });

  it('flags a top-level delegatecall to an untrusted MultiSend address', () => {
    const tx = multiSendCall(OTHER, [send(ALLOWED, 1n)]);
    const r = evaluate([policy(allowlist)], tx, ctx);
    expect(
      r.status === 'violation' && r.violations.map((v) => [v.rule, v.detail]),
    ).toEqual([['undecodable', 'delegatecall']]);
  });

  it('accepts an amount equal to the cap and flags cap + 1 wei', () => {
    const native = policy(cap('per_transfer', '1000', 'native'));
    expect(evaluate([native], send(ALLOWED, 1000n), ctx)).toEqual({
      status: 'ok',
    });
    expect(rulesOf(evaluate([native], send(ALLOWED, 1001n), ctx))).toEqual([
      ['amount_cap', ''],
    ]);
    const token = policy(cap('per_transfer', '1000'));
    expect(evaluate([token], erc20('transfer', ALLOWED, 1000n), ctx)).toEqual({
      status: 'ok',
    });
    expect(
      rulesOf(evaluate([token], erc20('transfer', ALLOWED, 1001n), ctx)),
    ).toEqual([['amount_cap', '']]);
  });

  it('matches a cap on a checksummed token address', () => {
    // caps are stored lowercase (schema); the tx target is checksummed
    expect(
      rulesOf(
        evaluate(
          [policy(cap('per_transfer', '1'))],
          erc20('transfer', ALLOWED, 2n, getAddress(USDC)),
          ctx,
        ),
      ),
    ).toEqual([['amount_cap', '']]);
  });

  it('distinguishes per_transfer, per_transaction and both on two transfers of 60 under a cap of 100', () => {
    const tx = ms([
      erc20('transfer', ALLOWED, 60n),
      transferFrom(ALLOWED, 60n),
    ]);
    expect(evaluate([policy(cap('per_transfer', '100'))], tx, ctx)).toEqual({
      status: 'ok',
    });
    expect(
      rulesOf(evaluate([policy(cap('per_transaction', '100'))], tx, ctx)),
    ).toEqual([
      ['amount_cap', '0'],
      ['amount_cap', '1'],
    ]);
    expect(rulesOf(evaluate([policy(cap('both', '100'))], tx, ctx))).toEqual([
      ['amount_cap', '0'],
      ['amount_cap', '1'],
    ]);
    const big = ms([erc20('transfer', ALLOWED, 150n)]);
    expect(
      rulesOf(evaluate([policy(cap('per_transfer', '100'))], big, ctx)),
    ).toEqual([['amount_cap', '0']]);
    expect(rulesOf(evaluate([policy(cap('both', '100'))], big, ctx))).toEqual([
      ['amount_cap', '0'],
      ['amount_cap', '0'],
    ]);
  });

  it('reports a per_transaction cap once per contributing call, naming the total', () => {
    const tx = ms([
      erc20('transfer', ALLOWED, 60n),
      send(ALLOWED, 1n),
      erc20('transfer', ALLOWED, 0n),
      erc20('approve', ALLOWED, 500n),
      erc20('transfer', ALLOWED, 60n),
    ]);
    const r = evaluate([policy(cap('per_transaction', '100'))], tx, ctx);
    expect(
      r.status === 'violation' &&
        r.violations.map((v) => [v.callPath, v.to, v.detail]),
    ).toEqual([
      ['0', USDC, expect.stringContaining('total 0.00012 USDC')],
      ['4', USDC, expect.stringContaining('total 0.00012 USDC')],
    ]);
    expect(
      rulesOf(
        evaluate(
          [policy(cap('per_transaction', '1', 'native'))],
          send(ALLOWED, 2n),
          ctx,
        ),
      ),
    ).toEqual([['amount_cap', '']]);
  });

  it('words cap violations in token units with the cap symbol, not raw units and addresses', () => {
    const details = (capMode: 'per_transfer' | 'per_transaction'): unknown => {
      const r = evaluate(
        [policy(cap(capMode, '1000500000'))],
        erc20('transfer', ALLOWED, 2_000_000_000n),
        ctx,
      );
      return r.status === 'violation' && r.violations.map((v) => v.detail);
    };
    expect(details('per_transfer')).toEqual([
      '2,000 USDC exceeds the per-transfer cap 1,000.5 USDC',
    ]);
    expect(details('per_transaction')).toEqual([
      'total 2,000 USDC in this transaction exceeds the per-transaction cap 1,000.5 USDC',
    ]);
  });

  it('sums native value across calls per transaction', () => {
    const tx = ms([send(ALLOWED, 60n), send(ALLOWED, 60n)]);
    expect(
      rulesOf(
        evaluate([policy(cap('per_transaction', '100', 'native'))], tx, ctx),
      ),
    ).toEqual([
      ['amount_cap', '0'],
      ['amount_cap', '1'],
    ]);
  });

  it('treats an approve or increaseAllowance spender as a recipient and its amount as capped', () => {
    const tx = ms([
      erc20('approve', STRANGER, 101n),
      increaseAllowance(STRANGER, 101n),
    ]);
    expect(rulesOf(evaluate([policy(allowlist)], tx, ctx))).toEqual([
      ['recipients_allowlist', '0'],
      ['recipients_allowlist', '1'],
    ]);
    expect(
      rulesOf(evaluate([policy(cap('per_transfer', '100'))], tx, ctx)),
    ).toEqual([
      ['amount_cap', '0'],
      ['amount_cap', '1'],
    ]);
    // an allowance is not spent yet: per_transaction sums transfers only
    expect(evaluate([policy(cap('per_transaction', '100'))], tx, ctx)).toEqual({
      status: 'ok',
    });
  });

  it('ignores caps and allowlist entries of another chain', () => {
    expect(
      evaluate(
        [policy(cap('both', '1', USDC.toLowerCase(), '10'))],
        erc20('transfer', ALLOWED, 5n),
        ctx,
      ),
    ).toEqual({ status: 'ok' });
    const calls: PolicyRule = {
      kind: 'call_allowlist',
      entries: [
        {
          chainId: '10',
          target: USDC.toLowerCase() as Address,
          selectors: 'any',
        },
      ],
    };
    expect(
      rulesOf(evaluate([policy(calls)], erc20('transfer', ALLOWED, 5n), ctx)),
    ).toEqual([['call_allowlist', '']]);
  });

  it('applies call_allowlist to calls with data only', () => {
    const rule: PolicyRule = {
      kind: 'call_allowlist',
      entries: [
        {
          chainId: '1',
          target: USDC.toLowerCase() as Address,
          selectors: ['0xa9059cbb'],
        },
        {
          chainId: '1',
          target: OTHER.toLowerCase() as Address,
          selectors: 'any',
        },
      ],
    };
    const tx = ms([
      send(STRANGER, 1n),
      erc20('transfer', ALLOWED, 1n),
      erc20('approve', ALLOWED, 1n),
      { to: OTHER, value: 0n, data: '0xabcdef0123', operation: 0 },
    ]);
    expect(rulesOf(evaluate([policy(rule)], tx, ctx))).toEqual([
      ['call_allowlist', '2'],
    ]);
  });

  it('flags a transfer whose arguments do not decode as undecodable', () => {
    const tx: SafeCall = {
      to: USDC,
      value: 0n,
      data: '0xa9059cbb1234',
      operation: 0,
    };
    expect(rulesOf(evaluate([policy(allowlist)], tx, ctx))).toEqual([
      ['undecodable', ''],
    ]);
  });

  it('returns violations of two policies in policy order', () => {
    const tx = ms([send(STRANGER, 500n), send(ALLOWED, 1n)]);
    const a = policy(cap('per_transfer', '100', 'native'));
    const b = policy(allowlist);
    const r = evaluate([a, b], tx, ctx);
    expect(
      r.status === 'violation' &&
        r.violations.map((v) => [v.policyId, v.rule, v.callPath]),
    ).toEqual([
      [a.id, 'amount_cap', '0'],
      [b.id, 'recipients_allowlist', '0'],
    ]);
    const r2 = evaluate([b, a], tx, ctx);
    expect(
      r2.status === 'violation' && r2.violations.map((v) => v.policyId),
    ).toEqual([b.id, a.id]);
  });

  it('orders violations by callPath numerically', () => {
    const calls = Array.from({ length: 11 }, () => send(STRANGER, 1n));
    const r = evaluate([policy(allowlist)], ms(calls), ctx);
    expect(
      r.status === 'violation' && r.violations.map((v) => v.callPath),
    ).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
  });
});
