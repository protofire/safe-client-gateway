import { z } from 'zod';

/**
 * Status codes the web app polls from `GET /v1/chains/:chainId/relay/status/:taskId`
 * (see `RelayTxWatcher` in the wallet monorepo).
 */
export enum RelayStatusCode {
  /** Queued, not yet sent to the chain */
  Pending = 100,
  /** Sent to the chain, awaiting inclusion */
  Submitted = 110,
  /** Included on-chain and succeeded */
  Included = 200,
  /** Never made it on-chain */
  Rejected = 400,
  /** Included on-chain but reverted */
  Reverted = 500,
}

export const RelayStatusSchema = z.object({
  status: z.enum(RelayStatusCode),
  receipt: z.object({ transactionHash: z.string() }).optional(),
});

export type RelayStatus = z.infer<typeof RelayStatusSchema>;
