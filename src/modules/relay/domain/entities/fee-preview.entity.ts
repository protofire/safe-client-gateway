import type { Address } from 'viem';

/**
 * Fee fields the proposer bakes into the SafeTx so the Safe pays the relayer in `gasToken`.
 * Shape follows what the web app's fee preview expects.
 */
export type FeePreview = {
  txData: {
    chainId: string;
    safeAddress: Address;
    safeTxGas: string;
    baseGas: string;
    /** Price per gas unit in the smallest unit of `gasToken`. */
    gasPrice: string;
    gasToken: Address;
    refundReceiver: Address;
    numberSignatures: number;
  };
  /** Native gas cost at quote time, for display only. */
  relayCost: {
    fiatCode: string;
    fiatValue: string;
  };
  pricingContextSnapshot: {
    phase: number;
    priceSource: string;
    /** Unix seconds */
    priceTimestamp: number;
    /** Multiplier applied to the native gas cost when quoting, e.g. 1.2 */
    gasPriceVolatilityBuffer: number;
  };
};
