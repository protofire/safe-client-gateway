import { z } from 'zod';
import type { Evaluation } from '@/modules/org/policies/evaluate';

/** One JSON row; a row that does not match is a 422 `invalid_rows` line (`invalid_row`), not a 400. */
export const PayoutRowInputSchema = z.object({
  address: z.string(),
  amount: z.string(),
  token: z.string(),
  name: z.string().optional(),
});
// count and cells are checked per line (checkPayoutRows); the body itself is bounded by express.jsonLimit
const rows = z.array(z.unknown());
const name = z.string().trim().min(1).max(64);
const expectedVersion = z.number().int().min(1);

export const CreatePayoutRunSchema = z.object({
  linkedSafeId: z.uuid(),
  name,
  rows,
});
export const ImportPayoutRunSchema = z.object({ linkedSafeId: z.uuid(), name });
export const UpdatePayoutRunSchema = z.object({
  expectedVersion,
  name: name.optional(),
  rows: rows.optional(),
});
export const BuildPayoutRunSchema = z.object({ expectedVersion });
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
    | 'indirect_unproven'
    | 'stray_proposal'
    /** a warning, status kept: the run's calls executed under another hash than the reported one */
    | 'executed_other_hash';
  lines?: Array<number>;
  /** `stray_proposal`: the queued copy of the run owners must reject. */
  nonce?: string;
  safeTxHash?: string;
  /** `stray_proposal` once settled: the outcome at the run's nonce and whether the copy executed too. */
  outcome?: 'executed' | 'failed' | 'replaced' | 'rejected' | 'needs_review';
  strayExecuted?: boolean;
  /** The reported hash when another safeTxHash with the run's calls executed (`safeTxHash` of the run is the executed one). */
  reportedSafeTxHash?: string;
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
