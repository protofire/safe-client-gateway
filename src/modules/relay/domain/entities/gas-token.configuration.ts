import type { Address } from 'viem';

export type GasTokenAllowlistEntry = {
  address: Address;
  decimals: number;
  /** Fixed USD price (e.g. 1 for a stablecoin on a testnet without a market). */
  usdPrice?: number;
};

export type GasTokenConfiguration = {
  /** Where the Safe's token refund goes, per chain id. */
  refundReceivers: Record<string, Address>;
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
