import { isAddress, type Address } from 'viem';
import { z } from 'zod';

const ChainIdSchema = z.string().regex(/^[1-9]\d{0,19}$/);
// stored lowercase so evaluation and the config hash compare plain strings
const LowerAddressSchema = z
  .string()
  .refine((v) => isAddress(v, { strict: false }), 'Invalid address')
  .transform((v) => v.toLowerCase() as Address);
/** Rejects an array element whose key repeats an earlier one (after lowercasing), at its index. */
function unique<T>(key: (x: T) => string, what: string) {
  return (items: Array<T>, ctx: z.RefinementCtx): void => {
    const seen = new Set<string>();
    items.forEach((item, i) => {
      const k = key(item);
      if (seen.has(k))
        ctx.addIssue({
          code: 'custom',
          message: `Duplicate ${what}`,
          path: [i],
        });
      seen.add(k);
    });
  };
}
const SelectorSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{8}$/)
  .transform((v) => v.toLowerCase() as `0x${string}`);

export const RecipientsAllowlistRuleSchema = z.object({
  kind: z.literal('recipients_allowlist'),
  tag: z.literal('allowed'),
});

export const CallAllowlistRuleSchema = z.object({
  kind: z.literal('call_allowlist'),
  entries: z
    .array(
      z.object({
        chainId: ChainIdSchema,
        target: LowerAddressSchema,
        selectors: z.union([
          z.literal('any'),
          z
            .array(SelectorSchema)
            .min(1)
            .max(200)
            .superRefine(unique((s) => s, 'selector')),
        ]),
      }),
    )
    .min(1)
    .max(200)
    .superRefine(unique((e) => `${e.chainId}:${e.target}`, 'call entry')),
});

export const AmountCapRuleSchema = z.object({
  kind: z.literal('amount_cap'),
  capMode: z.enum(['per_transfer', 'per_transaction', 'both']),
  caps: z
    .array(
      z.object({
        chainId: ChainIdSchema,
        token: z.union([z.literal('native'), LowerAddressSchema]),
        // uint256 raw units; > 2^256 is caught by B3 when parsing the decimal input
        maxRaw: z.string().regex(/^(0|[1-9]\d{0,77})$/),
        decimals: z.number().int().min(0).max(255),
        symbol: z.string().max(64),
      }),
    )
    .min(1)
    .max(50)
    .superRefine(unique((c) => `${c.chainId}:${c.token}`, 'cap')),
});

export const NoDelegatecallRuleSchema = z.object({
  kind: z.literal('no_delegatecall'),
});

export const PolicyRuleSchema = z.discriminatedUnion('kind', [
  RecipientsAllowlistRuleSchema,
  CallAllowlistRuleSchema,
  AmountCapRuleSchema,
  NoDelegatecallRuleSchema,
]);

export const PolicyScopeSchema = z.object({
  safes: z
    .array(z.object({ chainId: ChainIdSchema, address: LowerAddressSchema }))
    .max(200)
    .superRefine(unique((s) => `${s.chainId}:${s.address}`, 'Safe')),
  chainIds: z
    .array(ChainIdSchema)
    .max(200)
    .superRefine(unique((c) => c, 'chain')),
});

export type PolicyRule = z.infer<typeof PolicyRuleSchema>;
export type PolicyScope = z.infer<typeof PolicyScopeSchema>;

export type CompiledPolicy = {
  id: string;
  name: string;
  version: number;
  configHash: string;
  rules: Array<PolicyRule>;
};
