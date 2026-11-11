import { decodeFunctionData, parseAbi, type Address } from 'viem';
import { formatAmount } from '@/modules/org/common/amounts';
import {
  walkCalls,
  type FlatCall,
  type SafeCall,
} from '@/modules/org/common/multisend';
import type {
  CompiledPolicy,
  PolicyRule,
} from '@/modules/org/policies/policy-rules';

export type EvalContext = {
  chainId: string;
  allowedRecipients: ReadonlySet<string> /* lowercase */;
  trustedMultiSend: ReadonlySet<string> /* lowercase */;
};

export type Violation = {
  policyId: string;
  policyVersion: number;
  rule: PolicyRule['kind'] | 'undecodable' | 'nesting_too_deep';
  callPath: string /* '' top level, '3', '3.1' */;
  to: Address;
  detail: string;
};

export type Evaluation =
  | { status: 'ok' }
  | { status: 'violation'; violations: Array<Violation> };

const paymentAbi = parseAbi([
  'function transfer(address to, uint256 amount)',
  'function transferFrom(address from, address to, uint256 amount)',
  'function approve(address spender, uint256 amount)',
  'function increaseAllowance(address spender, uint256 amount)',
]);
const PAYMENT_SELECTORS = new Set([
  '0xa9059cbb',
  '0x23b872dd',
  '0x095ea7b3',
  '0x39509351',
]);

/** Value that leaves the Safe (or may be pulled, for an allowance) through one call. */
type Payment = {
  recipient: string;
  token: string;
  amount: bigint;
  allowance: boolean;
};

type Analysed = FlatCall & {
  payments: Array<Payment>;
  argsUndecodable: boolean;
};

function analyse(call: FlatCall): Analysed {
  const payments: Array<Payment> = [];
  if (call.value > 0n)
    payments.push({
      recipient: call.to.toLowerCase(),
      token: 'native',
      amount: call.value,
      allowance: false,
    });
  const selector = call.data.slice(0, 10).toLowerCase();
  if (!PAYMENT_SELECTORS.has(selector))
    return { ...call, payments, argsUndecodable: false };
  try {
    const { functionName, args } = decodeFunctionData({
      abi: paymentAbi,
      data: call.data,
    });
    const token = call.to.toLowerCase();
    const [recipient, amount] =
      functionName === 'transferFrom' ? [args[1], args[2]] : [args[0], args[1]];
    const allowance =
      functionName === 'approve' || functionName === 'increaseAllowance';
    payments.push({
      recipient: recipient.toLowerCase(),
      token,
      amount,
      allowance,
    });
    return { ...call, payments, argsUndecodable: false };
  } catch {
    return { ...call, payments, argsUndecodable: true };
  }
}

type Finding = Omit<Violation, 'policyId' | 'policyVersion'>;

function checkRule(
  rule: PolicyRule,
  tx: SafeCall,
  calls: Array<Analysed>,
  ctx: EvalContext,
): Array<Finding> {
  const out: Array<Finding> = [];
  switch (rule.kind) {
    case 'recipients_allowlist':
      for (const c of calls)
        for (const p of c.payments)
          if (!ctx.allowedRecipients.has(p.recipient))
            out.push({
              rule: rule.kind,
              callPath: c.callPath,
              to: c.to,
              detail: `recipient ${p.recipient} is not on the allowlist`,
            });
      return out;
    case 'call_allowlist': {
      const entries = rule.entries.filter((e) => e.chainId === ctx.chainId);
      for (const c of calls) {
        if (c.data.length <= 2) continue;
        const target = c.to.toLowerCase();
        const selector = c.data.slice(0, 10).toLowerCase();
        const allowed = entries.some(
          (e) =>
            e.target === target &&
            (e.selectors === 'any' || e.selectors.some((s) => s === selector)),
        );
        if (!allowed)
          out.push({
            rule: rule.kind,
            callPath: c.callPath,
            to: c.to,
            detail: `call ${selector} to ${target} is not on the allowlist`,
          });
      }
      return out;
    }
    case 'amount_cap': {
      const caps = rule.caps.filter((cap) => cap.chainId === ctx.chainId);
      const capsOf = (token: string): typeof caps =>
        caps.filter((cap) => cap.token === token);
      // "1,000.5 USDC": the cap's token metadata words both amounts
      const units = (raw: bigint, cap: (typeof caps)[number]): string => {
        const [whole, fraction] = formatAmount(raw, cap.decimals).split('.');
        const grouped = whole.replace(/\B(?=(\d{3})+$)/g, ',');
        return `${fraction ? `${grouped}.${fraction}` : grouped} ${cap.symbol || cap.token}`;
      };
      if (rule.capMode !== 'per_transfer') {
        // an allowance is not spent yet, so only transfers count towards the total
        const totals = new Map<
          string,
          { total: bigint; from: Array<Analysed> }
        >();
        for (const c of calls)
          for (const p of c.payments) {
            if (p.allowance || p.amount === 0n) continue;
            const t = totals.get(p.token) ?? { total: 0n, from: [] };
            t.total += p.amount;
            if (!t.from.includes(c)) t.from.push(c);
            totals.set(p.token, t);
          }
        // one violation per contributing call, so a payout item maps to its own warning
        for (const [token, { total, from }] of totals)
          for (const cap of capsOf(token))
            if (total > BigInt(cap.maxRaw))
              for (const c of from)
                out.push({
                  rule: rule.kind,
                  callPath: c.callPath,
                  to: c.to,
                  detail: `total ${units(total, cap)} in this transaction exceeds the per-transaction cap ${units(BigInt(cap.maxRaw), cap)}`,
                });
      }
      if (rule.capMode !== 'per_transaction')
        for (const c of calls)
          for (const p of c.payments)
            for (const cap of capsOf(p.token))
              if (p.amount > BigInt(cap.maxRaw))
                out.push({
                  rule: rule.kind,
                  callPath: c.callPath,
                  to: c.to,
                  detail: `${units(p.amount, cap)} exceeds the per-transfer cap ${units(BigInt(cap.maxRaw), cap)}`,
                });
      return out;
    }
    case 'no_delegatecall':
      // flattened calls are all operation 0; delegatecalls surface as walk issues
      return out;
  }
}

const pathKey = (path: string): Array<number> =>
  path === '' ? [] : path.split('.').map(Number);
function comparePaths(a: string, b: string): number {
  const x = pathKey(a);
  const y = pathKey(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++)
    if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}

/**
 * Pure policy check of one Safe transaction (MultiSend unpacked). Anything that
 * cannot be checked is a violation, never ok. Order: policy order, then callPath.
 */
export function evaluate(
  policies: ReadonlyArray<CompiledPolicy>,
  tx: SafeCall,
  ctx: EvalContext,
): Evaluation {
  const { calls: flat, issues } = walkCalls(tx, ctx.trustedMultiSend);
  const calls = flat.map(analyse);
  const violations: Array<Violation> = [];
  for (const policy of policies) {
    if (policy.rules.length === 0) continue;
    const kinds = new Set(policy.rules.map((r) => r.kind));
    const found: Array<Finding> = [];
    for (const issue of issues) {
      if (issue.reason === 'nesting_too_deep')
        found.push({
          rule: 'nesting_too_deep',
          callPath: issue.callPath,
          to: issue.to,
          detail: 'MultiSend nested deeper than 2',
        });
      else if (issue.reason === 'undecodable')
        found.push({
          rule: 'undecodable',
          callPath: issue.callPath,
          to: issue.to,
          detail: 'MultiSend data could not be decoded',
        });
      else {
        found.push({
          rule: 'undecodable',
          callPath: issue.callPath,
          to: issue.to,
          detail: 'delegatecall',
        });
        if (kinds.has('no_delegatecall'))
          found.push({
            rule: 'no_delegatecall',
            callPath: issue.callPath,
            to: issue.to,
            detail: 'delegatecall to a contract other than a trusted MultiSend',
          });
      }
    }
    if (kinds.has('recipients_allowlist') || kinds.has('amount_cap'))
      for (const c of calls)
        if (c.argsUndecodable)
          found.push({
            rule: 'undecodable',
            callPath: c.callPath,
            to: c.to,
            detail: 'token call arguments could not be decoded',
          });
    for (const rule of policy.rules)
      found.push(...checkRule(rule, tx, calls, ctx));
    found
      .sort((a, b) => comparePaths(a.callPath, b.callPath)) // stable: keeps issue-then-rule order per path
      .forEach((f) =>
        violations.push({
          policyId: policy.id,
          policyVersion: policy.version,
          ...f,
        }),
      );
  }
  return violations.length === 0
    ? { status: 'ok' }
    : { status: 'violation', violations };
}
