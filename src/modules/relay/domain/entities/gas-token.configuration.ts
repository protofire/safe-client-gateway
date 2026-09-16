import { isAddress, isAddressEqual, zeroAddress } from 'viem';
import { z } from 'zod';
import type { Address } from 'viem';

const NonZeroAddressSchema = z
  .string()
  .refine(isAddress, 'must be an address')
  .refine((value) => !isAddressEqual(value, zeroAddress), 'must be non-zero');
const PositivePriceSchema = z.number().positive();
const NativeSpendBudgetSchema = z.object({
  dailyLimitGwei: z.number().int().positive(),
  maxGasPriceWei: z
    .string()
    .regex(/^\d+$/)
    .refine((value) => BigInt(value) > 0),
});

export const GasTokenConfigurationSchema = z.object({
  refundReceivers: z.record(z.string(), NonZeroAddressSchema),
  nativeUsdPrices: z.record(z.string(), PositivePriceSchema),
  nativeSpendBudgets: z.record(z.string(), NativeSpendBudgetSchema),
  allowlist: z.record(
    z.string(),
    z
      .array(
        z.object({
          address: NonZeroAddressSchema,
          decimals: z.number().int().nonnegative().max(255),
          usdPrice: PositivePriceSchema.optional(),
        }),
      )
      .superRefine((entries, ctx) => {
        const seen = new Set<string>();
        entries.forEach((entry, index) => {
          const address = entry.address.toLowerCase();
          if (seen.has(address)) {
            ctx.addIssue({
              code: 'custom',
              path: [index, 'address'],
              message: 'duplicate token address',
            });
          }
          seen.add(address);
        });
      }),
  ),
  marginBps: z.number().int().nonnegative(),
  minMarginBps: z.number().int().nonnegative(),
  baseGas: z.number().int().nonnegative(),
  baseGasPerSignature: z.number().int().nonnegative(),
  gasLimitBuffer: z.number().int().nonnegative(),
});

export type GasTokenAllowlistEntry = {
  address: Address;
  decimals: number;
  /** Fixed USD price (e.g. 1 for a stablecoin on a testnet without a market). */
  usdPrice?: number;
};

export type GasTokenConfiguration = {
  /** Where the Safe's token refund goes, per chain id. */
  refundReceivers: Record<string, Address>;
  /** Fixed USD price of the native coin per chain id, for chains without a price feed (testnets). */
  nativeUsdPrices: Record<string, number>;
  /** Per-chain native spend reservation budget for Safe-pays relays. */
  nativeSpendBudgets: Record<
    string,
    { dailyLimitGwei: number; maxGasPriceWei: string }
  >;
  /** Tokens a Safe may pay its fee in, per chain id. */
  allowlist: Record<string, Array<GasTokenAllowlistEntry>>;
  /** Margin added on top of the native gas cost when quoting, in basis points. */
  marginBps: number;
  /** Minimum margin the signed refund must still cover at execution time, in basis points. */
  minMarginBps: number;
  /** Gas outside `safeTxGas` that the Safe refunds: intrinsic gas, calldata, the refund transfer, event. */
  baseGas: number;
  /** Extra calldata gas per signature, added to `baseGas`. */
  baseGasPerSignature: number;
  /** Added to the simulated gas when setting the relayer's gas limit. */
  gasLimitBuffer: number;
};
