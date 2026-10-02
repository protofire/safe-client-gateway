import { getAddress, isAddress, isAddressEqual, zeroAddress } from 'viem';
import { z } from 'zod';
import type { Address } from 'viem';
import { CoercedNumberSchema } from '@/validation/entities/schemas/coerced-number.schema';

const AddressSchema = z
  .string()
  .refine(isAddress, 'must be an address')
  .transform((value) => getAddress(value));
const NonZeroAddressSchema = AddressSchema.refine(
  (value) => !isAddressEqual(value, zeroAddress),
  'must be non-zero',
);
const PositivePriceSchema = z.number().positive();
/** config-service renders DecimalField as a string, e.g. "2500.00000000" */
const DecimalPriceSchema = CoercedNumberSchema.pipe(PositivePriceSchema);
/** A positive wei amount as a decimal string (uint256 does not fit a JSON number) */
const WeiStringSchema = z
  .string()
  .regex(/^\d+$/)
  .refine((value) => BigInt(value) > 0, 'must be positive');

const FeeTokenSchema = z.object({
  // The zero address stands for the chain's native coin
  address: AddressSchema,
  symbol: z.string().trim().min(1),
  decimals: z.number().int().nonnegative().max(255),
  usdPrice: PositivePriceSchema.optional(),
});

function rejectDuplicateAddresses(
  entries: Array<{ address: string }>,
  ctx: z.RefinementCtx,
): void {
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
}

/** OZ relayer ids go into URL paths and prefix OZ task ids (`<relayerId>:<ozId>`), so they must be URL-safe and colon-free. */
export const RELAYER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** `GET {safeConfig.baseUri}/api/v1/relay/chains/{chainId}/` — per-chain relay settings edited in the config-service admin. */
export const RelayChainSchema = z.object({
  relayerId: z.string().regex(RELAYER_ID_PATTERN),
  nativeUsdPrice: DecimalPriceSchema.nullable(),
  refundReceiver: NonZeroAddressSchema.nullable(),
  payFromSafeDailyBudgetWei: WeiStringSchema.nullable(),
  sponsoringDailyBudgetWei: WeiStringSchema.nullable(),
  sponsoringPerSafePerDay: z.number().int().positive().nullable(),
  sponsoringPerOwnerCreationsPerDay: z.number().int().nonnegative().nullable(),
  sponsoringMaxGasLimit: z.number().int().positive().nullable(),
  tokens: z
    .array(
      FeeTokenSchema.extend({
        // null = priced by the market
        usdPrice: DecimalPriceSchema.nullable().transform(
          (value) => value ?? undefined,
        ),
      }),
    )
    .superRefine(rejectDuplicateAddresses),
});

export type RelayChain = z.infer<typeof RelayChainSchema>;

/** Env (unchanged names, D7): margins and gas constants shared by every chain. */
export const GasTokenConfigurationSchema = z.object({
  marginBps: z.number().int().nonnegative(),
  minMarginBps: z.number().int().nonnegative(),
  baseGas: z.number().int().nonnegative(),
  baseGasPerSignature: z.number().int().nonnegative(),
  gasLimitBuffer: z.number().int().nonnegative(),
});

export type GasTokenAllowlistEntry = {
  /** Token contract, or the zero address for the chain's native coin. */
  address: Address;
  symbol: string;
  decimals: number;
  /** Fixed USD price (e.g. 1 for a stablecoin on a testnet without a market). */
  usdPrice?: number;
};

export type GasTokenConfiguration = {
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
