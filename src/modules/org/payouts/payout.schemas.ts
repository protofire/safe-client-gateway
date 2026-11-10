import { z } from 'zod';
import type { Evaluation } from '@/modules/org/policies/evaluate';

// the row count and every cell are checked by checkPayoutRows (422 invalid_rows), not here
const PayoutRowInputSchema = z.object({
  address: z.string().max(200),
  amount: z.string().max(200),
  token: z.string().max(200),
  name: z.string().max(200).optional(),
});
const rows = z.array(PayoutRowInputSchema).min(1).max(5_000);
const name = z.string().trim().min(1).max(64);

export const CreatePayoutRunSchema = z.object({
  linkedSafeId: z.uuid(),
  name,
  rows,
});
export const ImportPayoutRunSchema = z.object({ linkedSafeId: z.uuid(), name });
export const UpdatePayoutRunSchema = z.object({
  expectedVersion: z.number().int().min(1),
  name: name.optional(),
  rows: rows.optional(),
});
export const ListPayoutRunsSchema = z.object({
  linkedSafeId: z.uuid().optional(),
});

export type PayoutRowInput = z.infer<typeof PayoutRowInputSchema>;
export type UpdatePayoutRun = z.infer<typeof UpdatePayoutRunSchema>;

export type PayoutRunStatus =
  | 'draft'
  | 'proposing'
  | 'proposed'
  | 'verifying'
  | 'executed'
  | 'failed'
  | 'replaced'
  | 'rejected'
  | 'needs_review';

/** PATCH, DELETE and build are allowed only here (canonical status table). */
export const EDITABLE_STATUSES: ReadonlyArray<PayoutRunStatus> = [
  'draft',
  'failed',
  'replaced',
  'rejected',
];

export type PayoutItemWarning =
  | 'unknown_recipient'
  | 'duplicate'
  | 'self'
  | 'token_contract'
  | 'policy';

export type StoredCall = { to: string; value: string; data: string };

export type PayoutReview = {
  reason:
    | 'missing_transfers'
    | 'partial_overlap'
    | 'undecodable'
    | 'indirect_unproven';
  lines?: Array<number>;
};

export type PayoutRunListItem = {
  id: string;
  name: string;
  status: PayoutRunStatus;
  chainId: string;
  safeAddress: string;
  linkedSafeId: string | null;
  itemCount: number;
  safeTxHash: string | null;
  createdAt: string;
};

export type PayoutAttemptView = {
  id: string;
  status: 'open' | 'reported' | 'released';
  nonce: string;
  createdBy: string | null;
  createdAt: string;
  releasable: boolean;
};

export type PayoutRunView = {
  id: string;
  name: string;
  status: PayoutRunStatus;
  chainId: string;
  safeAddress: string;
  linkedSafeId: string | null;
  version: number;
  calls: Array<StoredCall> | null;
  estimatedGas: number | null;
  gasBound: number;
  evaluation: Evaluation | null;
  safeTxHash: string | null;
  nonce: string | null;
  executedTxHash: string | null;
  review: PayoutReview | null;
  pinnedNonce: string | null;
  verifyingSince: string | null;
  delayNotified: boolean;
  latestAttempt: PayoutAttemptView | null;
};

export type PayoutItemView = {
  id: string;
  line: number;
  recipient: string;
  name: string | null;
  token: string;
  symbol: string;
  decimals: number;
  amount: string;
  warnings: Array<PayoutItemWarning>;
};

export type PayoutRunWarning = {
  code: 'insufficient_balance' | 'balance_unknown';
  token: string;
  symbol: string;
  /** decimal strings in the token's units */
  required: string;
  available?: string;
};

export type PayoutRunDetail = {
  run: PayoutRunView;
  items: Array<PayoutItemView>;
  runWarnings: Array<PayoutRunWarning>;
};
