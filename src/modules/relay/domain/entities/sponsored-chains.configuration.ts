import { z } from 'zod';

const SponsoredChainSchema = z.object({
  perSafePerDay: z.number().int().positive(),
  perOwnerCreationsPerDay: z.number().int().nonnegative(),
  maxGasLimit: z.number().int().positive(),
  dailyBudgetGwei: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  maxGasPriceWei: z
    .string()
    .regex(/^\d+$/)
    .refine((value) => BigInt(value) > 0),
});

/** Chains on which the relayer pays gas (`gasPrice == 0`), keyed by chain id. Only chains listed here AND carrying RELAYING are sponsored. */
export const SponsoredChainsConfigurationSchema = z.record(
  z.string().regex(/^\d+$/),
  SponsoredChainSchema,
);

export type SponsoredChainConfiguration = z.infer<typeof SponsoredChainSchema>;
export type SponsoredChainsConfiguration = z.infer<
  typeof SponsoredChainsConfigurationSchema
>;
