import { z } from 'zod';
import {
  AmountCapRuleSchema,
  CallAllowlistRuleSchema,
  NoDelegatecallRuleSchema,
  RecipientsAllowlistRuleSchema,
  type PolicyRule,
  type PolicyScope,
} from '@/modules/org/policies/policy-rules';

export const MAX_POLICIES = 20;

const capInput = AmountCapRuleSchema.shape.caps.element.shape;

/** As stored, except an amount cap names `maxAmount` (decimal string) instead of raw units. */
export const PolicyRuleInputSchema = z.discriminatedUnion('kind', [
  RecipientsAllowlistRuleSchema,
  CallAllowlistRuleSchema,
  AmountCapRuleSchema.extend({
    caps: z
      .array(
        z.object({
          chainId: capInput.chainId,
          token: capInput.token,
          maxAmount: z.string().max(100),
        }),
      )
      .min(1)
      .max(50),
  }),
  NoDelegatecallRuleSchema,
]);
export type PolicyRuleInput = z.infer<typeof PolicyRuleInputSchema>;

// scope and rules are checked separately, so their errors carry paths (422 invalid_rules)
const policyBody = {
  name: z.string().trim().min(1).max(64),
  enabled: z.boolean(),
  scope: z.unknown(),
  rules: z.unknown(),
};
export const CreatePolicySchema = z.object(policyBody);
export const UpdatePolicySchema = z.object({
  ...policyBody,
  expectedVersion: z.number().int().min(1),
});
export type PolicyBody = z.infer<typeof CreatePolicySchema>;

export type RuleError = { path: string; reason: string };

type Cap = Extract<PolicyRule, { kind: 'amount_cap' }>['caps'][number];
export type PolicyRuleView =
  | Exclude<PolicyRule, { kind: 'amount_cap' }>
  | (Omit<Extract<PolicyRule, { kind: 'amount_cap' }>, 'caps'> & {
      caps: Array<Cap & { maxAmount: string }>;
    });

export type Policy = {
  id: string;
  name: string;
  status: 'active' | 'disabled';
  version: number;
  configHash: string;
  scope: PolicyScope;
  rules: Array<PolicyRuleView>;
  updatedAt: string;
};
