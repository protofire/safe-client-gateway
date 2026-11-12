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
export const ResolvePayoutRunSchema = z.object({
  expectedVersion,
  note: z.string().max(500).optional(),
});
export const ListPayoutRunsSchema = z.object({
  linkedSafeId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** `nextCursor` of the previous page (opaque). */
  cursor: z.string().max(200).optional(),
});
export type ListPayoutRuns = z.infer<typeof ListPayoutRunsSchema>;

export type PayoutRowInput = z.infer<typeof PayoutRowInputSchema>;
export type UpdatePayoutRun = z.infer<typeof UpdatePayoutRunSchema>;
export type ResolvePayoutRun = z.infer<typeof ResolvePayoutRunSchema>;

export type PayoutRunStatus =
  | 'draft'
  | 'proposing'
  | 'proposed'
  | 'verifying'
  | 'executed'
  | 'failed'
  | 'replaced'
  | 'rejected'
  | 'needs_review'
  /** needs_review closed by hand (`payouts.manage`); final */
  | 'resolved';

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
  reason: 'missing_transfers' | 'partial_overlap';
  /** `missing_transfers`: the item lines without their transfer */
  lines?: Array<number>;
};

/** What the calling member may do with the run now (permissions, status, attempts, pin). */
export type PayoutRunActions = {
  edit: boolean;
  build: boolean;
  propose: boolean;
  release: boolean;
  cancelReservation: boolean;
  delete: boolean;
  resolve: boolean;
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

/** Newest first; `nextCursor` null on the last page. */
export type PayoutRunPage = {
  items: Array<PayoutRunListItem>;
  nextCursor: string | null;
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
  /** null: not built, or the simulation was unavailable */
  simulation: RunSimulation | null;
  safeTxHash: string | null;
  nonce: string | null;
  executedTxHash: string | null;
  review: PayoutReview | null;
  pinnedNonce: string | null;
  verifyingSince: string | null;
  /** `resolved`: who closed the review (user id), when, and their note; `review` is kept */
  resolvedBy: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  latestAttempt: PayoutAttemptView | null;
  actions: PayoutRunActions;
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

export type PayoutRunWarning =
  | {
      code: 'insufficient_balance' | 'balance_unknown';
      token: string;
      symbol: string;
      /** decimal strings in the token's units */
      required: string;
      available?: string;
    }
  /** the run's transaction reverts in the on-chain simulation; `message` is the revert reason, present only when one was decoded */
  | { code: 'simulation_failed'; message?: string }
  /** built, but the chain could not simulate it (RPC down, no SimulateTxAccessor, Safe < 1.3.0) */
  | { code: 'simulation_unavailable' };

/** Newest on-chain simulation of the run's transaction (build or claim); `gasUsed` when ok, `reason` (a decoded revert reason only) when not. */
export type RunSimulation = {
  ok: boolean;
  reason?: string;
  gasUsed?: string;
  at: string;
};

export type PayoutRunDetail = {
  run: PayoutRunView;
  items: Array<PayoutItemView>;
  runWarnings: Array<PayoutRunWarning>;
};

/** OpenAPI only: the runtime schemas keep rows loose so a bad row is a per-line 422, not a 400. */
export const CreatePayoutRunDocSchema = CreatePayoutRunSchema.extend({
  rows: z.array(PayoutRowInputSchema),
});
export const UpdatePayoutRunDocSchema = UpdatePayoutRunSchema.extend({
  rows: z.array(PayoutRowInputSchema).optional(),
});
