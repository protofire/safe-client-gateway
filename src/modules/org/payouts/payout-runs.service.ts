import { createHash } from 'node:crypto';
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { z } from 'zod';
import {
  encodeFunctionData,
  encodePacked,
  getAddress,
  parseAbi,
  size,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import {
  getRevertReason,
  getSimulateTxAccessor,
  simulateSafeCall,
} from '@/domain/common/utils/simulate-tx-accessor';
import { IBlockchainApiManager } from '@/domain/interfaces/blockchain-api.manager.interface';
import { ITransactionApiManager } from '@/domain/interfaces/transaction-api.manager.interface';
import { IBalancesRepository } from '@/modules/balances/domain/balances.repository.interface';
import { IChainsRepository } from '@/modules/chains/domain/chains.repository.interface';
import { ActivityLog } from '@/modules/org/activity/activity-log.service';
import {
  AmountError,
  formatAmount,
  parseAmountStrict,
} from '@/modules/org/common/amounts';
import type { SafeCall } from '@/modules/org/common/multisend';
import { tokenMeta, type TokenMeta } from '@/modules/org/common/token-meta';
import { OrgTransaction } from '@/modules/org/db/org-transaction';
import { RateLimiter } from '@/modules/org/common/rate-limiter';
import {
  conflict,
  lockOrgs,
  recheckPermission,
} from '@/modules/org/orgs/org-lock';
import type { Actor } from '@/modules/org/orgs/parse';
import {
  PermissionResolver,
  type EffectivePermissions,
} from '@/modules/org/permissions/permission.resolver';
import type { Permission } from '@/modules/org/permissions/permissions';
import { evaluate, type Evaluation } from '@/modules/org/policies/evaluate';
import { PolicyContextService } from '@/modules/org/policies/policy-context.service';
import {
  CALLDATA_BYTE_GAS,
  checkRunSize,
  PAYOUT_GAS_BOUND,
  toCall,
  TX_OVERHEAD_GAS,
} from '@/modules/org/payouts/payout-calls';
import {
  checkPayoutRows,
  MAX_PAYOUT_ROWS,
  parsePayoutCsv,
  type PayoutCsvError,
  type PayoutCsvRow,
  type PayoutRowCells,
} from '@/modules/org/payouts/payout-csv.parser';
import {
  EDITABLE_STATUSES,
  PayoutRowInputSchema,
  type PayoutAttemptView,
  type PayoutItemView,
  type PayoutItemWarning,
  type PayoutReview,
  type PayoutRunDetail,
  type ListPayoutRuns,
  type PayoutRunPage,
  type PayoutRunStatus,
  type PayoutRunView,
  type PayoutRunWarning,
  type RunSimulation,
  type StoredCall,
  type UpdatePayoutRun,
} from '@/modules/org/payouts/payout.schemas';
import { multiSendCallOnlySet } from '@/modules/org/payouts/payout-verify';
import { mapLimit } from '@/modules/org/safes/map-limit';

/** A `payout_runs` row as read by {@link lockRun}. */
export type PayoutRunRow = {
  id: string;
  org_id: string;
  chain_id: string;
  safe_address: string /* lowercase */;
  name: string;
  status: PayoutRunStatus;
  version: number;
  created_by: string | null;
  calls: Array<StoredCall> | null;
  est_gas: string | null;
  evaluation: Evaluation | null;
  simulation: RunSimulation | null;
  pinned_nonce: string | null;
  safe_tx_hash: string | null;
  nonce: string | null;
  executed_tx_hash: string | null;
  verifying_since: Date | null;
  resolved_by: string | null;
  resolved_at: Date | null;
  resolution_note: string | null;
  review: PayoutReview | null;
  created_at: Date;
};

/** A `payout_items` row as read by {@link readItems}. `warnings` holds the static ones only. */
export type PayoutItemRow = {
  id: string;
  line_no: number;
  recipient: string /* lowercase */;
  token: string /* 'native' or lowercase */;
  amount: string;
  amount_raw: string;
  decimals: number;
  symbol: string;
  name: string | null;
  warnings: Array<PayoutItemWarning>;
};

const RUN_COLUMNS = `id, org_id, chain_id, safe_address::text AS safe_address, name, status, version,
  created_by, calls, est_gas::text AS est_gas, evaluation, simulation, pinned_nonce::text AS pinned_nonce,
  safe_tx_hash, nonce::text AS nonce, executed_tx_hash, verifying_since,
  resolved_by, resolved_at, resolution_note, review, created_at`;

// abuse limits (milestone P): creation is cheap to call and costly to serve
const CREATES_PER_USER_PER_HOUR = 60;
const CREATES_PER_ORG_PER_HOUR = 300;
// each build simulates the run over RPC
const BUILDS_PER_USER_PER_MINUTE = 30;
const SIMULATION_FAILED = 'The transaction would fail on-chain';
/** Runs not settled yet (`draft | proposing | proposed | verifying`) an org may hold. */
export const MAX_OPEN_RUNS_PER_ORG = 500;
const OPEN_RUN_STATUSES: ReadonlyArray<PayoutRunStatus> = [
  'draft',
  'proposing',
  'proposed',
  'verifying',
];

/**
 * 409 `run_limit` when `run` (null: a new one) would become open while the
 * org already holds {@link MAX_OPEN_RUNS_PER_ORG}; call under the org lock.
 * Runs already open are exempt.
 */
export async function assertRunCapacity(
  em: EntityManager,
  orgId: string,
  run: Pick<PayoutRunRow, 'status'> | null,
): Promise<void> {
  if (run && OPEN_RUN_STATUSES.includes(run.status)) return;
  const [{ open }]: Array<{ open: number }> = await em.query(
    `SELECT count(*)::int AS open FROM payout_runs WHERE org_id = $1 AND status = ANY($2)`,
    [orgId, OPEN_RUN_STATUSES],
  );
  if (open >= MAX_OPEN_RUNS_PER_ORG) {
    throw conflict(
      'run_limit',
      `The organization has ${MAX_OPEN_RUNS_PER_ORG} open payout runs; settle or delete some first`,
    );
  }
}

/** 409 `run_locked { status }`: the run's status does not allow the action. */
export function runLocked(
  status: PayoutRunStatus,
  message: string,
): ConflictException {
  return new ConflictException({
    statusCode: 409,
    code: 'run_locked',
    status,
    message,
  });
}

/**
 * Org lock, then the caller's membership and permission again (org not
 * deleted): the guard checked them before any wait or external read. Runs
 * first in every committing transaction of a run mutation; lock order
 * org → run → Safe.
 */
export async function lockOrgFor(
  resolver: PermissionResolver,
  em: EntityManager,
  orgId: string,
  userId: string,
  permission: Permission,
): Promise<EffectivePermissions> {
  await lockOrgs(em, [orgId]);
  return recheckPermission(resolver, em, orgId, userId, permission);
}

/** Every run mutation starts here: the run row lock (404 if the run is not this org's). */
export async function lockRun(
  em: EntityManager,
  orgId: string,
  runId: string,
): Promise<PayoutRunRow> {
  const [row]: Array<PayoutRunRow> = await em.query(
    `SELECT ${RUN_COLUMNS} FROM payout_runs WHERE org_id = $1 AND id = $2 FOR UPDATE`,
    [orgId, runId],
  );
  if (!row) throw new NotFoundException('Payout run not found');
  return row;
}

/** Items in line order. */
export function readItems(
  em: EntityManager,
  orgId: string,
  runId: string,
): Promise<Array<PayoutItemRow>> {
  return em.query(
    `SELECT id, line_no, recipient::text AS recipient, token, amount, amount_raw::text AS amount_raw,
            decimals, symbol, name, warnings
       FROM payout_items WHERE org_id = $1 AND run_id = $2 ORDER BY line_no`,
    [orgId, runId],
  );
}

/** The run's calls in line order, as the UI and B7 compare them. */
export function itemCalls(
  items: ReadonlyArray<
    Pick<PayoutItemRow, 'recipient' | 'token' | 'amount_raw'>
  >,
): Array<SafeCall> {
  return items.map((i) =>
    toCall({
      recipient: getAddress(i.recipient),
      token: i.token === 'native' ? 'native' : getAddress(i.token),
      amountRaw: BigInt(i.amount_raw),
    }),
  );
}

export const storedCalls = (
  calls: ReadonlyArray<SafeCall>,
): Array<StoredCall> =>
  calls.map(({ to, value, data }) => ({ to, value: value.toString(), data }));

/** Inverse of {@link storedCalls}: every payout call is a plain call. */
export const fromStoredCalls = (
  calls: ReadonlyArray<StoredCall>,
): Array<SafeCall> =>
  calls.map((c) => ({
    to: getAddress(c.to),
    value: BigInt(c.value),
    data: c.data as Hex,
    operation: 0,
  }));

/**
 * sha256 hex of the sorted `line|recipient|token|amount_raw` tuples, so an
 * activity entry shows when the money content changed (e.g. swapped recipients).
 */
export function itemsHash(
  items: ReadonlyArray<
    Pick<PayoutItemRow, 'line_no' | 'recipient' | 'token' | 'amount_raw'>
  >,
): string {
  const tuples = items
    .map((i) => `${i.line_no}|${i.recipient}|${i.token}|${i.amount_raw}`)
    .sort();
  return createHash('sha256').update(tuples.join('\n')).digest('hex');
}

/** Items not yet paid out: their balance still matters. */
const BALANCE_STATUSES: ReadonlyArray<PayoutRunStatus> = [
  ...EDITABLE_STATUSES,
  'proposing',
  'proposed',
];
const LOCKED_MESSAGE =
  'The run is being proposed or settled, or it is final; it cannot be changed now';

const AMOUNT_REASONS: Record<AmountError['code'], string> = {
  too_many_decimals: 'too_many_decimals',
  invalid: 'invalid_amount',
  zero: 'zero_amount',
  overflow: 'amount_overflow',
};
const TOKEN_REASONS: Record<Exclude<TokenMeta, object>, string> = {
  unknown: 'unknown_token',
  not_erc20: 'not_erc20',
  decimals_unknown: 'token_decimals_unknown',
};

type PreparedItem = {
  line: number;
  recipient: string /* lowercase */;
  token: string /* 'native' or lowercase */;
  amount: string;
  amountRaw: bigint;
  decimals: number;
  symbol: string;
  name: string | null;
};

const multiSendAbi = parseAbi(['function multiSend(bytes transactions)']);
/**
 * The wrapper of the policy preview. Its inner calls are the run's own plain
 * calls, so trusting this one address checks exactly what the UI's
 * MultiSendCallOnly will carry, without reading the chain config (no HTTP).
 */
const PREVIEW_MULTISEND: Address = zeroAddress;

/** `multiSend(calls)` calldata. */
function multiSendData(calls: ReadonlyArray<SafeCall>): Hex {
  const packed = encodePacked(
    calls.flatMap(() => ['uint8', 'address', 'uint256', 'uint256', 'bytes']),
    calls.flatMap((c) => [
      c.operation,
      c.to,
      c.value,
      BigInt(size(c.data)),
      c.data,
    ]),
  );
  return encodeFunctionData({
    abi: multiSendAbi,
    functionName: 'multiSend',
    args: [packed],
  });
}

/** The outer shape the UI builds (SafeAppsTxFlow): one call direct, more as a MultiSend delegatecall. */
function outerTx(calls: ReadonlyArray<SafeCall>): SafeCall {
  if (calls.length === 1) return calls[0];
  const data = multiSendData(calls);
  return { to: PREVIEW_MULTISEND, value: 0n, data, operation: 1 };
}

/** Gas from a simulation with the relay's margins (×1.1 + 10k), plus the Safe overhead and the outer calldata. */
function simulatedGas(gasUsed: string, calls: ReadonlyArray<SafeCall>): bigint {
  const estimate = BigInt(gasUsed);
  return (
    estimate +
    estimate / 10n +
    10_000n +
    TX_OVERHEAD_GAS +
    CALLDATA_BYTE_GAS * BigInt(size(multiSendData(calls)))
  );
}

/** Run warnings of the stored simulation; none before the run is built. */
function simulationWarnings(
  run: Pick<PayoutRunView, 'calls' | 'simulation'>,
): Array<PayoutRunWarning> {
  if (run.calls === null) return [];
  if (run.simulation === null) return [{ code: 'simulation_unavailable' }];
  return run.simulation.ok
    ? []
    : [
        {
          code: 'simulation_failed',
          message: run.simulation.reason ?? SIMULATION_FAILED,
        },
      ];
}

/** Item index a violation belongs to: '' is the direct call of a one-item run, else the first path segment. */
function itemIndex(callPath: string, count: number): number | null {
  if (callPath === '') return count === 1 ? 0 : null;
  return Number(callPath.split('.')[0]);
}

/** Warnings that depend only on the rows and the run's Safe; stored with the items. */
function staticWarnings(
  safeAddress: string,
  items: ReadonlyArray<{ recipient: string; token: string }>,
): Array<Array<PayoutItemWarning>> {
  const key = (i: { recipient: string; token: string }): string =>
    `${i.recipient}:${i.token}`;
  const seen = new Map<string, number>();
  for (const i of items) seen.set(key(i), (seen.get(key(i)) ?? 0) + 1);
  return items.map((i) => {
    const w: Array<PayoutItemWarning> = [];
    if (seen.get(key(i))! > 1) w.push('duplicate');
    if (i.recipient === safeAddress) w.push('self');
    if (i.recipient === i.token) w.push('token_contract');
    return w;
  });
}

function invalidRows(
  errors: Array<PayoutCsvError>,
): UnprocessableEntityException {
  return new UnprocessableEntityException({
    statusCode: 422,
    message: 'Some rows are invalid; nothing was stored',
    code: 'invalid_rows',
    errors: [...errors].sort((a, b) => a.line - b.line),
  });
}

function versionConflict(): ReturnType<typeof conflict> {
  return conflict(
    'version_conflict',
    'The run was changed meanwhile; reload and try again',
  );
}

/** Throws 422 `run_too_large` when the calls do not fit one transaction: by the simulated gas if given, else the fixed estimate. */
export function assertRunSize(
  calls: ReadonlyArray<SafeCall>,
  simulated?: bigint,
): bigint {
  const size = checkRunSize(calls);
  const estimatedGas = simulated ?? size.estimatedGas;
  if (estimatedGas <= PAYOUT_GAS_BOUND) return estimatedGas;
  // shortcut: with only a simulated total, the recipients that fit are prorated
  const maxRecipients = size.ok
    ? Number((BigInt(calls.length) * PAYOUT_GAS_BOUND) / estimatedGas)
    : size.maxRecipients;
  const gasBound = Number(PAYOUT_GAS_BOUND);
  throw new UnprocessableEntityException({
    statusCode: 422,
    code: 'run_too_large',
    message: `This run needs about ${estimatedGas} gas; one transaction allows ${gasBound}. Split the CSV into runs of at most ${maxRecipients} recipients.`,
    maxRecipients,
    estimatedGas: Number(estimatedGas),
    gasBound,
  });
}

/** JSON rows get the CSV row checks; lines are 1-based row positions. */
export function checkJsonRows(rows: ReadonlyArray<unknown>): {
  rows: Array<PayoutCsvRow>;
  errors: Array<PayoutCsvError>;
} {
  if (rows.length === 0) {
    return { rows: [], errors: [{ line: 1, reason: 'no_rows' }] };
  }
  if (rows.length > MAX_PAYOUT_ROWS) {
    return {
      rows: [],
      errors: [{ line: MAX_PAYOUT_ROWS + 1, reason: 'too_many_rows' }],
    };
  }
  const errors: Array<PayoutCsvError> = [];
  const cells: Array<PayoutRowCells> = [];
  rows.forEach((raw, i) => {
    const row = PayoutRowInputSchema.safeParse(raw);
    if (row.success) cells.push({ line: i + 1, ...row.data });
    else errors.push({ line: i + 1, reason: 'invalid_row' });
  });
  const checked = checkPayoutRows(cells);
  return { rows: checked.rows, errors: [...errors, ...checked.errors] };
}

const CursorSchema = z.tuple([z.iso.datetime({ precision: 6 }), z.uuid()]);

const encodeCursor = (createdAt: string, id: string): string =>
  Buffer.from(JSON.stringify([createdAt, id])).toString('base64url');

/** 400 for anything that is not a cursor this API issued. */
function decodeCursor(cursor: string): { createdAt: string; id: string } {
  try {
    const [createdAt, id] = CursorSchema.parse(
      JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')),
    );
    return { createdAt, id };
  } catch {
    throw new BadRequestException('Invalid cursor');
  }
}

/** Payout run drafts: rows, warnings and the one-transaction build. */
@Injectable()
export class PayoutRunsService {
  constructor(
    private readonly tx: OrgTransaction,
    private readonly log: ActivityLog,
    private readonly resolver: PermissionResolver,
    private readonly policies: PolicyContextService,
    private readonly rateLimiter: RateLimiter,
    @Inject(IChainsRepository) private readonly chains: IChainsRepository,
    @Inject(ITransactionApiManager)
    private readonly transactionApis: ITransactionApiManager,
    @Inject(IBalancesRepository)
    private readonly balances: IBalancesRepository,
    @Inject(IBlockchainApiManager)
    private readonly blockchain: IBlockchainApiManager,
  ) {}

  /** Keyset page, newest first: `(created_at, id)` below the cursor's. */
  list(orgId: string, query: ListPayoutRuns): Promise<PayoutRunPage> {
    const after = query.cursor ? decodeCursor(query.cursor) : null;
    return this.tx.runInOrgTx(async (em) => {
      const params: Array<unknown> = [orgId];
      let where = '';
      if (query.linkedSafeId) {
        const safe = await this.linkedSafe(em, orgId, query.linkedSafeId);
        params.push(safe.chainId, safe.address);
        where += ` AND r.chain_id = $2 AND r.safe_address = $3`;
      }
      if (after) {
        params.push(after.createdAt, after.id);
        where += ` AND (r.created_at, r.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
      }
      params.push(query.limit + 1);
      const rows: Array<{
        id: string;
        name: string;
        status: PayoutRunStatus;
        chain_id: string;
        safe_address: string;
        linked_safe_id: string | null;
        item_count: number;
        safe_tx_hash: string | null;
        created_at: Date;
        /** full precision (microseconds) for the cursor */
        created_at_text: string;
      }> = await em.query(
        `SELECT r.id, r.name, r.status, r.chain_id, r.safe_address::text AS safe_address,
                ls.id AS linked_safe_id, r.safe_tx_hash, r.created_at,
                to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_text,
                (SELECT count(*)::int FROM payout_items i
                  WHERE i.org_id = r.org_id AND i.run_id = r.id) AS item_count
           FROM payout_runs r
           LEFT JOIN linked_safes ls
             ON ls.org_id = r.org_id AND ls.chain_id = r.chain_id AND ls.address = r.safe_address
          WHERE r.org_id = $1 ${where}
          ORDER BY r.created_at DESC, r.id DESC
          LIMIT $${params.length}`,
        params,
      );
      const more = rows.length > query.limit;
      const page = more ? rows.slice(0, query.limit) : rows;
      const last = page.at(-1);
      const items = page.map((r) => ({
        id: r.id,
        name: r.name,
        status: r.status,
        chainId: r.chain_id,
        safeAddress: getAddress(r.safe_address),
        linkedSafeId: r.linked_safe_id,
        itemCount: r.item_count,
        safeTxHash: r.safe_tx_hash,
        createdAt: r.created_at.toISOString(),
      }));
      return {
        items,
        nextCursor:
          more && last ? encodeCursor(last.created_at_text, last.id) : null,
      };
    }, orgId);
  }

  async get(
    orgId: string,
    runId: string,
    userId: string,
  ): Promise<PayoutRunDetail> {
    const { run, items, rows } = await this.tx.runInOrgTx(
      (em) => this.read(em, orgId, runId, userId),
      orgId,
    );
    // balances over HTTP after the transaction
    const runWarnings = BALANCE_STATUSES.includes(run.status)
      ? [
          ...(await this.runWarnings(run.chainId, run.safeAddress, rows)),
          ...simulationWarnings(run),
        ]
      : [];
    return { run, items, runWarnings };
  }

  create(
    orgId: string,
    input: { linkedSafeId: string; name: string; rows: Array<unknown> },
    actor: Actor,
  ): Promise<PayoutRunDetail> {
    return this.createFrom(orgId, input, checkJsonRows(input.rows), actor);
  }

  /** CSV rows: lines are file lines. */
  import(
    orgId: string,
    input: { linkedSafeId: string; name: string; csv: string },
    actor: Actor,
  ): Promise<PayoutRunDetail> {
    const { rows, errors } = parsePayoutCsv(input.csv);
    if (rows.length === 0 && errors.length === 0) {
      errors.push({ line: 2, reason: 'no_rows' });
    }
    return this.createFrom(orgId, input, { rows, errors }, actor);
  }

  async update(
    orgId: string,
    runId: string,
    input: UpdatePayoutRun,
    actor: Actor,
  ): Promise<PayoutRunDetail> {
    // fast 409s before any token read; rechecked under the lock
    const before = await this.peek(orgId, runId, input.expectedVersion);
    const prepared = input.rows
      ? await this.prepare(before.chain_id, checkJsonRows(input.rows))
      : null;
    await this.tx.runInOrgTx(async (em) => {
      await this.lockOrg(em, orgId, actor);
      const run = await this.lockEditable(
        em,
        orgId,
        runId,
        input.expectedVersion,
      );
      const name = input.name ?? run.name;
      if (!prepared && name === run.name) return;
      // a settled run becomes a draft again
      await assertRunCapacity(em, orgId, run);
      if (prepared) {
        await em.query(
          `DELETE FROM payout_items WHERE org_id = $1 AND run_id = $2`,
          [orgId, runId],
        );
        await this.insertItems(em, run, prepared);
      }
      // a pinned draft keeps its pin: every later claim of this run uses it
      await em.query(
        `UPDATE payout_runs
            SET name = $3, status = 'draft', version = version + 1, calls = NULL, est_gas = NULL,
                evaluation = NULL, simulation = NULL, safe_tx_hash = NULL, nonce = NULL, executed_tx_hash = NULL,
                review = NULL, verifying_since = NULL, updated_at = now()
          WHERE org_id = $1 AND id = $2`,
        [orgId, runId, name],
      );
      await this.event(em, 'payout_run.updated', { ...run, name }, actor, {
        fromStatus: run.status,
      });
    }, orgId);
    return this.get(orgId, runId, actor.userId);
  }

  remove(orgId: string, runId: string, actor: Actor): Promise<void> {
    return this.tx.runInOrgTx(async (em) => {
      const caller = await this.lockOrg(em, orgId, actor);
      const run = await lockRun(em, orgId, runId);
      this.assertEditable(run);
      if (run.pinned_nonce !== null) {
        throw conflict(
          'run_pinned',
          `The run holds nonce ${run.pinned_nonce}; it can be deleted once a transaction at that nonce executes`,
        );
      }
      if (!caller.permissions.includes('payouts.manage')) {
        // its proposal history (signed attempts) is evidence: only payouts.manage removes it
        const attempts: Array<unknown> = await em.query(
          `SELECT 1 FROM payout_proposal_attempts WHERE org_id = $1 AND run_id = $2 LIMIT 1`,
          [orgId, runId],
        );
        if (attempts.length > 0) {
          throw new ForbiddenException({
            statusCode: 403,
            code: 'forbidden',
            message:
              'This run was proposed before; only an admin can delete it',
          });
        }
      }
      await this.event(em, 'payout_run.deleted', run, actor);
      await em.query(`DELETE FROM payout_runs WHERE org_id = $1 AND id = $2`, [
        orgId,
        runId,
      ]);
    }, orgId);
  }

  /** Stores the run's calls (one Safe transaction), estimate and policy evaluation; bumps `version`. */
  async build(
    orgId: string,
    runId: string,
    expectedVersion: number,
    actor: Actor,
  ): Promise<PayoutRunDetail> {
    await this.rateLimiter.enforce(
      `payouts:build:user:${actor.userId}`,
      BUILDS_PER_USER_PER_MINUTE,
      60,
    );
    // RPC before the transaction; the version lock below guarantees the items did not change since
    const before = await this.peek(orgId, runId, expectedVersion);
    const simulation = await this.simulate(
      before.chain_id,
      before.safe_address,
      itemCalls(
        await this.tx.runInOrgTx((em) => readItems(em, orgId, runId), orgId),
      ),
    );
    await this.tx.runInOrgTx(async (em) => {
      await this.lockOrg(em, orgId, actor);
      const run = await this.lockEditable(em, orgId, runId, expectedVersion);
      await assertRunCapacity(em, orgId, run);
      const calls = itemCalls(await readItems(em, orgId, runId));
      const estimatedGas = assertRunSize(
        calls,
        simulation?.ok ? simulatedGas(simulation.gasUsed!, calls) : undefined,
      );
      const evaluation = await this.evaluateCalls(em, run, calls);
      // a new transaction: earlier proposal fields go; the pin stays
      await em.query(
        `UPDATE payout_runs
            SET status = 'draft', version = version + 1, calls = $3::jsonb, est_gas = $4,
                evaluation = $5::jsonb, simulation = $6::jsonb, safe_tx_hash = NULL, nonce = NULL,
                executed_tx_hash = NULL, review = NULL, verifying_since = NULL, updated_at = now()
          WHERE org_id = $1 AND id = $2`,
        [
          orgId,
          runId,
          JSON.stringify(storedCalls(calls)),
          estimatedGas.toString(),
          JSON.stringify(evaluation),
          simulation && JSON.stringify(simulation),
        ],
      );
      await this.event(em, 'payout_run.updated', run, actor, {
        fromStatus: run.status,
      });
    }, orgId);
    return this.get(orgId, runId, actor.userId);
  }

  /**
   * The run's transaction simulated on chain at latest: the Safe's `simulateAndRevert` running
   * MultiSendCallOnly as a delegatecall. RPC, so never inside a transaction. Null when the chain
   * cannot simulate it; a revert is a result (warning), never an error.
   */
  async simulate(
    chainId: string,
    safeAddress: string,
    calls: ReadonlyArray<SafeCall>,
  ): Promise<RunSimulation | null> {
    const accessor = getSimulateTxAccessor(chainId);
    if (!accessor) return null;
    try {
      const chain = await this.chains.getChain(chainId);
      const [callOnly] = multiSendCallOnlySet(
        chainId,
        chain.contractAddresses.multiSendCallOnlyAddress ?? undefined,
      );
      if (!callOnly) return null;
      const result = await simulateSafeCall(
        await this.blockchain.getApi(chainId),
        {
          safeAddress: getAddress(safeAddress),
          accessor,
          to: getAddress(callOnly),
          value: 0n,
          data: multiSendData(calls),
          operation: 1,
        },
      );
      if (!result) return null;
      const at = new Date().toISOString();
      return result.success
        ? { ok: true, gasUsed: result.estimate.toString(), at }
        : {
            ok: false,
            // a token's revert text is shown to users: bounded
            reason: getRevertReason(result.returnData, SIMULATION_FAILED).slice(
              0,
              200,
            ),
            at,
          };
    } catch {
      return null;
    }
  }

  // ---- helpers ----

  private async createFrom(
    orgId: string,
    input: { linkedSafeId: string; name: string },
    checked: { rows: Array<PayoutCsvRow>; errors: Array<PayoutCsvError> },
    actor: Actor,
  ): Promise<PayoutRunDetail> {
    await this.rateLimiter.enforce(
      `payouts:create:user:${actor.userId}`,
      CREATES_PER_USER_PER_HOUR,
      3600,
    );
    await this.rateLimiter.enforce(
      `payouts:create:org:${orgId}`,
      CREATES_PER_ORG_PER_HOUR,
      3600,
    );
    const safe = await this.tx.runInOrgTx(
      (em) => this.linkedSafe(em, orgId, input.linkedSafeId),
      orgId,
    );
    // token and chain reads before the transaction: no DB connection held during HTTP
    const prepared = await this.prepare(safe.chainId, checked);
    const runId = await this.tx.runInOrgTx(async (em) => {
      await this.lockOrg(em, orgId, actor);
      // the Safe may have been unlinked meanwhile
      await this.linkedSafe(em, orgId, input.linkedSafeId);
      await assertRunCapacity(em, orgId, null);
      const [run]: Array<PayoutRunRow> = await em.query(
        `INSERT INTO payout_runs (org_id, chain_id, safe_address, name, created_by)
         VALUES ($1, $2, $3, $4, $5) RETURNING ${RUN_COLUMNS}`,
        [orgId, safe.chainId, safe.address, input.name, actor.userId],
      );
      await this.insertItems(em, run, prepared);
      await this.event(em, 'payout_run.created', run, actor);
      return run.id;
    }, orgId);
    return this.get(orgId, runId, actor.userId);
  }

  /**
   * Token metadata and strict amounts; any row error → 422 `invalid_rows`
   * (all-or-nothing), then the one-transaction size check → 422 `run_too_large`.
   */
  private async prepare(
    chainId: string,
    checked: {
      rows: Array<PayoutCsvRow>;
      errors: Array<PayoutCsvError>;
    },
  ): Promise<Array<PreparedItem>> {
    const errors = [...checked.errors];
    const tokens = [...new Set(checked.rows.map((r) => r.token))];
    const metas = new Map(
      await mapLimit(
        tokens,
        5,
        async (t) => [t, await this.meta(chainId, t)] as const,
      ),
    );
    const items: Array<PreparedItem> = [];
    for (const row of checked.rows) {
      const meta = metas.get(row.token)!;
      if (typeof meta === 'string') {
        errors.push({ line: row.line, reason: TOKEN_REASONS[meta] });
        continue;
      }
      try {
        items.push({
          line: row.line,
          recipient: row.address,
          token: row.token,
          amount: row.amount,
          amountRaw: parseAmountStrict(row.amount, meta.decimals),
          decimals: meta.decimals,
          symbol: meta.symbol,
          name: row.name ?? null,
        });
      } catch (e) {
        if (!(e instanceof AmountError)) throw e;
        errors.push({ line: row.line, reason: AMOUNT_REASONS[e.code] });
      }
    }
    if (errors.length > 0) throw invalidRows(errors);
    assertRunSize(itemCalls(items.map(asItemRow)));
    return items;
  }

  private async meta(chainId: string, token: string): Promise<TokenMeta> {
    try {
      return await tokenMeta(
        { chains: this.chains, transactionApis: this.transactionApis },
        chainId,
        token === 'native' ? 'native' : getAddress(token),
      );
    } catch {
      throw new BadGatewayException('Could not read token details');
    }
  }

  private async insertItems(
    em: EntityManager,
    run: PayoutRunRow,
    items: Array<PreparedItem>,
  ): Promise<void> {
    const warnings = staticWarnings(run.safe_address, items);
    await em.query(
      `INSERT INTO payout_items
         (org_id, run_id, line_no, recipient, token, amount, amount_raw, decimals, symbol, name, warnings)
       SELECT $1, $2, x.line_no, x.recipient, x.token, x.amount, x.amount_raw::numeric, x.decimals,
              x.symbol, x.name, ARRAY(SELECT jsonb_array_elements_text(x.warnings))
         FROM jsonb_to_recordset($3::jsonb) AS x(
           line_no int, recipient text, token text, amount text, amount_raw text,
           decimals int, symbol text, name text, warnings jsonb)`,
      [
        run.org_id,
        run.id,
        JSON.stringify(
          items.map((item, i) => ({
            line_no: item.line,
            recipient: item.recipient,
            token: item.token,
            amount: item.amount,
            amount_raw: item.amountRaw.toString(),
            decimals: item.decimals,
            symbol: item.symbol,
            name: item.name,
            warnings: warnings[i],
          })),
        ),
      ],
    );
  }

  /** Policy check of the transaction the UI will build, from the current policies; DB only, not logged. Also used by the claim (B8). */
  async evaluateCalls(
    em: EntityManager,
    run: PayoutRunRow,
    calls: ReadonlyArray<SafeCall>,
  ): Promise<Evaluation> {
    const policies = await this.policies.activePolicies(em, run.org_id, {
      chainId: run.chain_id,
      address: getAddress(run.safe_address),
    });
    if (policies.length === 0) return { status: 'ok' };
    const ctx = await this.policies.context(
      em,
      run.org_id,
      run.chain_id,
      new Set([PREVIEW_MULTISEND]),
    );
    return evaluate(policies, outerTx(calls), ctx);
  }

  /** Per token, Σ amount_raw against the Safe's balance; HTTP, so never inside a transaction. */
  private async runWarnings(
    chainId: string,
    safeAddress: string,
    items: ReadonlyArray<PayoutItemRow>,
  ): Promise<Array<PayoutRunWarning>> {
    const sums = new Map<
      string,
      { raw: bigint; decimals: number; symbol: string }
    >();
    for (const i of items) {
      const s = sums.get(i.token) ?? {
        raw: 0n,
        decimals: i.decimals,
        symbol: i.symbol,
      };
      s.raw += BigInt(i.amount_raw);
      sums.set(i.token, s);
    }
    let available: Map<string, bigint> | null = null;
    try {
      const chain = await this.chains.getChain(chainId);
      const balances = await this.balances.getBalances({
        chain,
        safeAddress: getAddress(safeAddress),
        fiatCode: 'USD',
        trusted: false,
        excludeSpam: false,
      });
      available = new Map(
        balances.map((b) => [
          b.tokenAddress === null ? 'native' : b.tokenAddress.toLowerCase(),
          BigInt(b.balance),
        ]),
      );
    } catch {
      available = null;
    }
    const out: Array<PayoutRunWarning> = [];
    for (const [token, s] of sums) {
      const view = {
        token: token === 'native' ? 'native' : getAddress(token),
        symbol: s.symbol,
        required: formatAmount(s.raw, s.decimals),
      };
      if (available === null) {
        out.push({ code: 'balance_unknown', ...view });
        continue;
      }
      // a token missing from the list is held at 0
      const has = available.get(token) ?? 0n;
      if (has < s.raw) {
        out.push({
          code: 'insufficient_balance',
          ...view,
          available: formatAmount(has, s.decimals),
        });
      }
    }
    return out;
  }

  /**
   * The run under FOR SHARE (items consistent with it). `unknown_recipient`,
   * `policy` and `evaluation` come from the current contacts and policies.
   */
  private async read(
    em: EntityManager,
    orgId: string,
    runId: string,
    userId: string,
  ): Promise<{
    run: PayoutRunView;
    items: Array<PayoutItemView>;
    rows: Array<PayoutItemRow>;
  }> {
    const [r]: Array<PayoutRunRow & { linked_safe_id: string | null }> =
      await em.query(
        `SELECT ${RUN_COLUMNS},
                (SELECT ls.id FROM linked_safes ls
                  WHERE ls.org_id = r.org_id AND ls.chain_id = r.chain_id
                    AND ls.address = r.safe_address) AS linked_safe_id
           FROM payout_runs r WHERE r.org_id = $1 AND r.id = $2 FOR SHARE OF r`,
        [orgId, runId],
      );
    if (!r) throw new NotFoundException('Payout run not found');
    const rows = await readItems(em, orgId, runId);

    const calls = r.calls ? fromStoredCalls(r.calls) : itemCalls(rows);
    // editable runs follow the current policies; once a run left draft it keeps
    // the evaluation it was built (or claimed) with
    const evaluation = EDITABLE_STATUSES.includes(r.status)
      ? await this.evaluateCalls(em, r, calls)
      : r.evaluation;
    const flagged = new Set<number>();
    if (evaluation?.status === 'violation') {
      for (const v of evaluation.violations) {
        const index = itemIndex(v.callPath, calls.length);
        if (index !== null) flagged.add(index);
      }
    }
    const contacts: Array<{ address: string }> = await em.query(
      `SELECT lower(address::text) AS address FROM contacts
        WHERE org_id = $1 AND chain_ids @> ARRAY[$2::text]`,
      [orgId, r.chain_id],
    );
    const known = new Set(contacts.map((c) => c.address));
    const permissions =
      (await this.resolver.effective(orgId, userId, em))?.permissions ?? [];
    const prepare = permissions.includes('payouts.prepare');
    const manage = permissions.includes('payouts.manage');
    const editable = EDITABLE_STATUSES.includes(r.status);
    const linked = r.linked_safe_id !== null;
    const latestAttempt = await this.latestAttempt(em, r, userId, manage);
    const releasable = latestAttempt?.releasable ?? false;

    return {
      run: {
        id: r.id,
        name: r.name,
        status: r.status,
        chainId: r.chain_id,
        safeAddress: getAddress(r.safe_address),
        linkedSafeId: r.linked_safe_id,
        version: r.version,
        calls: r.calls,
        estimatedGas: r.est_gas === null ? null : Number(r.est_gas),
        gasBound: Number(PAYOUT_GAS_BOUND),
        evaluation: r.calls ? (evaluation ?? null) : null,
        simulation: r.simulation,
        safeTxHash: r.safe_tx_hash,
        nonce: r.nonce,
        executedTxHash: r.executed_tx_hash,
        review: r.review,
        pinnedNonce: r.pinned_nonce,
        verifyingSince: r.verifying_since?.toISOString() ?? null,
        resolvedBy: r.resolved_by,
        resolvedAt: r.resolved_at?.toISOString() ?? null,
        resolutionNote: r.resolution_note,
        latestAttempt,
        actions: {
          edit: prepare && editable && linked,
          build: prepare && editable && linked,
          propose: prepare && editable && linked && r.calls !== null,
          release: prepare && releasable,
          // the UI's on-chain rejection at the pin; an active attempt is released first
          cancelReservation:
            prepare &&
            r.pinned_nonce !== null &&
            (r.status === 'draft' || releasable),
          // a proposed run's attempts are evidence: only payouts.manage deletes it
          delete:
            prepare &&
            editable &&
            r.pinned_nonce === null &&
            (manage || latestAttempt === null),
          resolve: manage && r.status === 'needs_review',
        },
      },
      items: rows.map((i, index) => ({
        id: i.id,
        line: i.line_no,
        recipient: getAddress(i.recipient),
        name: i.name,
        token: i.token === 'native' ? 'native' : getAddress(i.token),
        symbol: i.symbol,
        decimals: i.decimals,
        amount: i.amount,
        warnings: [
          ...(known.has(i.recipient) ? [] : ['unknown_recipient' as const]),
          ...i.warnings,
          ...(flagged.has(index) ? ['policy' as const] : []),
        ],
      })),
      rows,
    };
  }

  /**
   * While `proposing | proposed`: the attempt bound to the active proposal
   * (the open one, or the reported one carrying the run's safeTxHash), the
   * one a release acts on. Otherwise the newest attempt.
   */
  private async latestAttempt(
    em: EntityManager,
    r: PayoutRunRow,
    userId: string,
    manage: boolean,
  ): Promise<PayoutAttemptView | null> {
    const active = r.status === 'proposing' || r.status === 'proposed';
    const WHERE: Partial<Record<PayoutRunStatus, string>> = {
      proposing: `AND status = 'open'`,
      proposed: `AND status = 'reported' AND safe_tx_hash = $3`,
    };
    const where = WHERE[r.status] ?? '';
    const [a]: Array<{
      id: string;
      status: PayoutAttemptView['status'];
      nonce: string;
      created_by: string | null;
      created_at: Date;
    }> = await em.query(
      `SELECT id, status, nonce::text AS nonce, created_by, created_at
         FROM payout_proposal_attempts WHERE org_id = $1 AND run_id = $2 ${where}
        ORDER BY created_at DESC, id DESC LIMIT 1`,
      r.status === 'proposed'
        ? [r.org_id, r.id, r.safe_tx_hash]
        : [r.org_id, r.id],
    );
    if (!a) return null;
    // the claimer or payouts.manage may release the active attempt (B8)
    const releasable = active && (a.created_by === userId || manage);
    return {
      id: a.id,
      status: a.status,
      nonce: a.nonce,
      createdBy: a.created_by,
      createdAt: a.created_at.toISOString(),
      releasable,
    };
  }

  private lockOrg(
    em: EntityManager,
    orgId: string,
    actor: Actor,
  ): Promise<EffectivePermissions> {
    return lockOrgFor(
      this.resolver,
      em,
      orgId,
      actor.userId,
      'payouts.prepare',
    );
  }

  /** Unlocked read for fast 409s before any HTTP; the mutation re-checks under the lock. */
  private async peek(
    orgId: string,
    runId: string,
    expectedVersion: number,
  ): Promise<PayoutRunRow> {
    const [run]: Array<PayoutRunRow> = await this.tx.runInOrgTx(
      (em) =>
        em.query(
          `SELECT ${RUN_COLUMNS} FROM payout_runs WHERE org_id = $1 AND id = $2`,
          [orgId, runId],
        ),
      orgId,
    );
    if (!run) throw new NotFoundException('Payout run not found');
    this.assertEditable(run);
    if (run.version !== expectedVersion) throw versionConflict();
    return run;
  }

  /** Row lock, then status, version and link checks (PATCH, build). */
  private async lockEditable(
    em: EntityManager,
    orgId: string,
    runId: string,
    expectedVersion: number,
  ): Promise<PayoutRunRow> {
    const run = await lockRun(em, orgId, runId);
    this.assertEditable(run);
    if (run.version !== expectedVersion) throw versionConflict();
    // linked_safes has no RLS (A3): filter by org explicitly
    const linked: Array<unknown> = await em.query(
      `SELECT 1 FROM linked_safes WHERE org_id = $1 AND chain_id = $2 AND address = $3`,
      [orgId, run.chain_id, run.safe_address],
    );
    if (linked.length === 0) {
      throw conflict(
        'safe_unlinked',
        'The Safe of this run is no longer linked to the organization',
      );
    }
    return run;
  }

  private assertEditable(run: PayoutRunRow): void {
    if (!EDITABLE_STATUSES.includes(run.status)) {
      throw runLocked(run.status, LOCKED_MESSAGE);
    }
  }

  // linked_safes has no RLS (A3): filter by org explicitly
  private async linkedSafe(
    em: EntityManager,
    orgId: string,
    linkedSafeId: string,
  ): Promise<{ chainId: string; address: string /* lowercase */ }> {
    const [row]: Array<{ chain_id: string; address: string }> = await em.query(
      `SELECT chain_id, lower(address::text) AS address FROM linked_safes WHERE org_id = $1 AND id = $2`,
      [orgId, linkedSafeId],
    );
    if (!row) throw new NotFoundException('Linked Safe not found');
    return { chainId: row.chain_id, address: row.address };
  }

  /** Item count and hash read in the same transaction, after the change. */
  private async event(
    em: EntityManager,
    type: 'payout_run.created' | 'payout_run.updated' | 'payout_run.deleted',
    run: PayoutRunRow,
    actor: Actor,
    extra: { fromStatus?: PayoutRunStatus } = {},
  ): Promise<void> {
    const items = await readItems(em, run.org_id, run.id);
    await this.log.record(em, {
      orgId: run.org_id,
      actorUserId: actor.userId,
      type,
      targetType: 'payout_run',
      targetId: run.id,
      payload: {
        name: run.name,
        chainId: run.chain_id,
        address: getAddress(run.safe_address),
        items: items.length,
        itemsHash: itemsHash(items),
        ...extra,
      },
      ip: actor.ip,
      userAgent: actor.userAgent,
    });
  }
}

const asItemRow = (
  i: PreparedItem,
): Pick<PayoutItemRow, 'recipient' | 'token' | 'amount_raw'> => ({
  recipient: i.recipient,
  token: i.token,
  amount_raw: i.amountRaw.toString(),
});
