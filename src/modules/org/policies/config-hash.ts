import { createHash } from 'node:crypto';
import type {
  PolicyRule,
  PolicyScope,
} from '@/modules/org/policies/policy-rules';

// code-unit order, not localeCompare: the hash must not depend on the locale
const cmp = (a: string, b: string): number => Number(a > b) - Number(a < b);
const byKeys =
  <T>(...keys: Array<(x: T) => string>) =>
  (a: T, b: T): number => {
    for (const key of keys) {
      const c = cmp(key(a), key(b));
      if (c !== 0) return c;
    }
    return 0;
  };

function canonicalRule(rule: PolicyRule): PolicyRule {
  switch (rule.kind) {
    case 'call_allowlist':
      return {
        ...rule,
        entries: rule.entries
          .map((e) => ({
            ...e,
            target: e.target.toLowerCase() as typeof e.target,
            selectors:
              e.selectors === 'any'
                ? e.selectors
                : e.selectors.map((s) => s.toLowerCase() as typeof s).sort(cmp),
          }))
          .sort(
            byKeys(
              (e) => e.chainId,
              (e) => e.target,
            ),
          ),
      };
    case 'amount_cap':
      return {
        ...rule,
        caps: rule.caps
          .map((c) => ({
            ...c,
            token: c.token.toLowerCase() as typeof c.token,
          }))
          .sort(
            byKeys(
              (c) => c.chainId,
              (c) => c.token,
            ),
          ),
      };
    default:
      return rule;
  }
}

/** JSON with object keys sorted at every level. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => cmp(a, b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** sha256 hex of the canonical `{ scope, rules }` of one policy version. */
export function configHash(
  scope: PolicyScope,
  rules: Array<PolicyRule>,
): string {
  const canonical = {
    scope: {
      chainIds: [...scope.chainIds].sort(cmp),
      safes: scope.safes
        .map((s) => ({ ...s, address: s.address.toLowerCase() }))
        .sort(
          byKeys(
            (s) => s.chainId,
            (s) => s.address,
          ),
        ),
    },
    rules: rules.map(canonicalRule).sort(byKeys((r) => r.kind)),
  };
  return createHash('sha256').update(canonicalJson(canonical)).digest('hex');
}
