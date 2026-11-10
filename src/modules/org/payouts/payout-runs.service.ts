import {
  BadGatewayException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { EntityManager } from 'typeorm';
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
import { z } from 'zod';
import { DataSourceError } from '@/domain/errors/data-source.error';
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
import { OrgTransaction } from '@/modules/org/db/org-transaction';
import { conflict } from '@/modules/org/orgs/org-lock';
import type { Actor } from '@/modules/org/orgs/parse';
import { PermissionResolver } from '@/modules/org/permissions/permission.resolver';
import { evaluate, type Evaluation } from '@/modules/org/policies/evaluate';
import { PolicyContextService } from '@/modules/org/policies/policy-context.service';
import {
  checkRunSize,
  PAYOUT_GAS_BOUND,
  toCall,
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
  type PayoutAttemptView,
  type PayoutItemView,
  type PayoutItemWarning,
  type PayoutReview,
  type PayoutRowInput,
  type PayoutRunDetail,
  type PayoutRunListItem,
  type PayoutRunStatus,
  type PayoutRunView,
  type PayoutRunWarning,
  type StoredCall,
  type UpdatePayoutRun,
} from '@/modules/org/payouts/payout.schemas';
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
  pinned_nonce: string | null;
  safe_tx_hash: string | null;
  nonce: string | null;
  executed_tx_hash: string | null;
  verifying_since: Date | null;
  delay_notified_at: Date | null;
  review: PayoutReview | null;
  created_at: Date;
};

/** A `payout_items` row as read by {@link readItems}. */
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
  created_by, calls, est_gas::text AS est_gas, evaluation, pinned_nonce::text AS pinned_nonce,
  safe_tx_hash, nonce::text AS nonce, executed_tx_hash, verifying_since, delay_notified_at,
  review, created_at`;

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

async function itemCount(
  em: EntityManager,
  orgId: string,
  runId: string,
): Promise<number> {
  const [{ n }]: Array<{ n: number }> = await em.query(
    `SELECT count(*)::int AS n FROM payout_items WHERE org_id = $1 AND run_id = $2`,
    [orgId, runId],
  );
  return n;
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

/** Items not yet paid out: their balance still matters. */
const BALANCE_STATUSES: ReadonlyArray<PayoutRunStatus> = [
  ...EDITABLE_STATUSES,
  'proposing',
  'proposed',
];
const LOCKED_MESSAGE =
  'The run is being proposed or settled; it cannot be changed now';

const AMOUNT_REASONS: Record<AmountError['code'], string> = {
  too_many_decimals: 'too_many_decimals',
  invalid: 'invalid_amount',
  zero: 'zero_amount',
  overflow: 'amount_overflow',
};

// only what an item needs from the raw tx-service token; decimals may be absent upstream
const RawTokenSchema = z.object({
  type: z.string(),
  symbol: z.string(),
  decimals: z.number().int().min(0).max(255).nullish(),
});
type TokenMeta = { decimals: number; symbol: string } | { reason: string };

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

/** The outer shape the UI builds (SafeAppsTxFlow): one call direct, more as a MultiSend delegatecall. */
function outerTx(calls: ReadonlyArray<SafeCall>, multiSend: Address): SafeCall {
  if (calls.length === 1) return calls[0];
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
  const data: Hex = encodeFunctionData({
    abi: multiSendAbi,
    functionName: 'multiSend',
    args: [packed],
  });
  return { to: multiSend, value: 0n, data, operation: 1 };
}

/** Item index a violation belongs to: '' is the direct call of a one-item run, else the first path segment. */
function itemIndex(callPath: string, count: number): number | null {
  if (callPath === '') return count === 1 ? 0 : null;
  return Number(callPath.split('.')[0]);
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

/** Throws 422 `run_too_large` when the calls do not fit one transaction. */
export function assertRunSize(calls: ReadonlyArray<SafeCall>): bigint {
  const size = checkRunSize(calls);
  if (size.ok) return size.estimatedGas;
  const gasBound = Number(PAYOUT_GAS_BOUND);
  throw new UnprocessableEntityException({
    statusCode: 422,
    code: 'run_too_large',
    message: `This run needs about ${size.estimatedGas} gas; one transaction allows ${gasBound}. Split the CSV into runs of at most ${size.maxRecipients} recipients.`,
    maxRecipients: size.maxRecipients,
    estimatedGas: Number(size.estimatedGas),
    gasBound,
  });
}

/** Payout run drafts: rows, warnings and the one-transaction build. */
@Injectable()
export class PayoutRunsService {
  constructor(
    private readonly tx: OrgTransaction,
    private readonly log: ActivityLog,
    private readonly resolver: PermissionResolver,
    private readonly policies: PolicyContextService,
    @Inject(IChainsRepository) private readonly chains: IChainsRepository,
    @Inject(ITransactionApiManager)
    private readonly transactionApis: ITransactionApiManager,
    @Inject(IBalancesRepository)
    private readonly balances: IBalancesRepository,
  ) {}

  list(
    orgId: string,
    linkedSafeId?: string,
  ): Promise<Array<PayoutRunListItem>> {
    return this.tx.runInOrgTx(async (em) => {
      const params: Array<unknown> = [orgId];
      let where = '';
      if (linkedSafeId) {
        const safe = await this.linkedSafe(em, orgId, linkedSafeId);
        params.push(safe.chainId, safe.address);
        where = `AND r.chain_id = $2 AND r.safe_address = $3`;
      }
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
      }> = await em.query(
        `SELECT r.id, r.name, r.status, r.chain_id, r.safe_address::text AS safe_address,
                ls.id AS linked_safe_id, r.safe_tx_hash, r.created_at,
                (SELECT count(*)::int FROM payout_items i
                  WHERE i.org_id = r.org_id AND i.run_id = r.id) AS item_count
           FROM payout_runs r
           LEFT JOIN linked_safes ls
             ON ls.org_id = r.org_id AND ls.chain_id = r.chain_id AND ls.address = r.safe_address
          WHERE r.org_id = $1 ${where}
          ORDER BY r.created_at DESC, r.id`,
        params,
      );
      return rows.map((r) => ({
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
    }, orgId);
  }

  async get(
    orgId: string,
    runId: string,
    userId: string,
  ): Promise<PayoutRunDetail> {
    const { run, items } = await this.tx.runInOrgTx(
      (em) => this.read(em, orgId, runId, userId),
      orgId,
    );
    // balances over HTTP after the transaction
    const runWarnings = BALANCE_STATUSES.includes(run.status)
      ? await this.runWarnings(run.chainId, run.safeAddress, items)
      : [];
    return { run, items, runWarnings };
  }

  /** JSON rows: lines are 1-based row positions. */
  create(
    orgId: string,
    input: { linkedSafeId: string; name: string; rows: Array<PayoutRowInput> },
    actor: Actor,
  ): Promise<PayoutRunDetail> {
    return this.createFrom(
      orgId,
      input,
      () => this.checkJsonRows(input.rows),
      actor,
    );
  }

  /** CSV rows: lines are file lines. */
  import(
    orgId: string,
    input: { linkedSafeId: string; name: string; csv: string },
    actor: Actor,
  ): Promise<PayoutRunDetail> {
    return this.createFrom(
      orgId,
      input,
      () => {
        const { rows, errors } = parsePayoutCsv(input.csv);
        if (rows.length === 0 && errors.length === 0) {
          errors.push({ line: 2, reason: 'no_rows' });
        }
        return { rows, errors };
      },
      actor,
    );
  }

  async update(
    orgId: string,
    runId: string,
    input: UpdatePayoutRun,
    actor: Actor,
  ): Promise<PayoutRunDetail> {
    const before = await this.peek(orgId, runId);
    const { rows } = input;
    const prepared = rows
      ? await this.prepare(before.chain_id, this.checkJsonRows(rows))
      : null;
    const trusted = prepared
      ? await this.policies.trustedMultiSend(before.chain_id)
      : null;
    await this.tx.runInOrgTx(async (em) => {
      const run = await lockRun(em, orgId, runId);
      this.assertEditable(run);
      if (run.version !== input.expectedVersion) {
        throw conflict(
          'version_conflict',
          'The run was changed meanwhile; reload and try again',
        );
      }
      const name = input.name ?? run.name;
      if (!prepared && name === run.name) return;
      if (prepared && trusted) {
        await em.query(
          `DELETE FROM payout_items WHERE org_id = $1 AND run_id = $2`,
          [orgId, runId],
        );
        await this.insertItems(em, run, prepared, trusted);
      }
      // a pinned draft keeps its pin: every later claim of this run uses it
      await em.query(
        `UPDATE payout_runs
            SET name = $3, status = 'draft', version = version + 1, calls = NULL, est_gas = NULL,
                evaluation = NULL, safe_tx_hash = NULL, nonce = NULL, executed_tx_hash = NULL,
                review = NULL, verifying_since = NULL, delay_notified_at = NULL, updated_at = now()
          WHERE org_id = $1 AND id = $2`,
        [orgId, runId, name],
      );
      const n = await itemCount(em, orgId, runId);
      await this.event(em, 'payout_run.updated', { ...run, name }, n, actor);
    }, orgId);
    return this.get(orgId, runId, actor.userId);
  }

  remove(orgId: string, runId: string, actor: Actor): Promise<void> {
    return this.tx.runInOrgTx(async (em) => {
      const run = await lockRun(em, orgId, runId);
      this.assertEditable(run);
      if (run.pinned_nonce !== null) {
        throw conflict(
          'run_pinned',
          `The run holds nonce ${run.pinned_nonce}; it can be deleted once a transaction at that nonce executes`,
        );
      }
      const n = await itemCount(em, orgId, runId);
      await em.query(`DELETE FROM payout_runs WHERE org_id = $1 AND id = $2`, [
        orgId,
        runId,
      ]);
      await this.event(em, 'payout_run.deleted', run, n, actor);
    }, orgId);
  }

  /** Stores the run's calls (one Safe transaction), estimate and policy evaluation; bumps `version`. */
  async build(
    orgId: string,
    runId: string,
    userId: string,
  ): Promise<PayoutRunDetail> {
    const before = await this.peek(orgId, runId);
    const trusted = await this.policies.trustedMultiSend(before.chain_id);
    await this.tx.runInOrgTx(async (em) => {
      const run = await lockRun(em, orgId, runId);
      this.assertEditable(run);
      const items = await readItems(em, orgId, runId);
      const calls = itemCalls(items);
      const estimatedGas = assertRunSize(calls);
      const evaluation = await this.evaluateCalls(em, run, calls, trusted);
      const warnings = await this.itemWarnings(
        em,
        run,
        items.map((i) => ({ recipient: i.recipient, token: i.token })),
        evaluation,
      );
      await em.query(
        `UPDATE payout_items i
            SET warnings = ARRAY(SELECT jsonb_array_elements_text(x.warnings)), updated_at = now()
           FROM jsonb_to_recordset($3::jsonb) AS x(id uuid, warnings jsonb)
          WHERE i.org_id = $1 AND i.run_id = $2 AND i.id = x.id`,
        [
          orgId,
          runId,
          JSON.stringify(
            items.map((i, n) => ({ id: i.id, warnings: warnings[n] })),
          ),
        ],
      );
      // a new transaction: earlier proposal fields go; the pin stays
      await em.query(
        `UPDATE payout_runs
            SET status = 'draft', version = version + 1, calls = $3::jsonb, est_gas = $4,
                evaluation = $5::jsonb, safe_tx_hash = NULL, nonce = NULL, executed_tx_hash = NULL,
                review = NULL, verifying_since = NULL, delay_notified_at = NULL, updated_at = now()
          WHERE org_id = $1 AND id = $2`,
        [
          orgId,
          runId,
          JSON.stringify(storedCalls(calls)),
          estimatedGas.toString(),
          JSON.stringify(evaluation),
        ],
      );
    }, orgId);
    return this.get(orgId, runId, userId);
  }

  // ---- helpers ----

  private async createFrom(
    orgId: string,
    input: { linkedSafeId: string; name: string },
    rows: () => { rows: Array<PayoutCsvRow>; errors: Array<PayoutCsvError> },
    actor: Actor,
  ): Promise<PayoutRunDetail> {
    const safe = await this.tx.runInOrgTx(
      (em) => this.linkedSafe(em, orgId, input.linkedSafeId),
      orgId,
    );
    // token, chain and MultiSend reads before the transaction: no DB connection held during HTTP
    const prepared = await this.prepare(safe.chainId, rows());
    const trusted = await this.policies.trustedMultiSend(safe.chainId);
    const runId = await this.tx.runInOrgTx(async (em) => {
      // the Safe may have been unlinked meanwhile
      await this.linkedSafe(em, orgId, input.linkedSafeId);
      const [run]: Array<PayoutRunRow> = await em.query(
        `INSERT INTO payout_runs (org_id, chain_id, safe_address, name, created_by)
         VALUES ($1, $2, $3, $4, $5) RETURNING ${RUN_COLUMNS}`,
        [orgId, safe.chainId, safe.address, input.name, actor.userId],
      );
      await this.insertItems(em, run, prepared, trusted);
      await this.event(em, 'payout_run.created', run, prepared.length, actor);
      return run.id;
    }, orgId);
    return this.get(orgId, runId, actor.userId);
  }

  private checkJsonRows(rows: Array<PayoutRowInput>): {
    rows: Array<PayoutCsvRow>;
    errors: Array<PayoutCsvError>;
  } {
    if (rows.length > MAX_PAYOUT_ROWS) {
      return {
        rows: [],
        errors: [{ line: MAX_PAYOUT_ROWS + 1, reason: 'too_many_rows' }],
      };
    }
    const cells: Array<PayoutRowCells> = rows.map((r, i) => ({
      line: i + 1,
      ...r,
    }));
    return checkPayoutRows(cells);
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
        async (t) => [t, await this.tokenMeta(chainId, t)] as const,
      ),
    );
    const items: Array<PreparedItem> = [];
    for (const row of checked.rows) {
      const meta = metas.get(row.token)!;
      if ('reason' in meta) {
        errors.push({ line: row.line, reason: meta.reason });
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

  private async tokenMeta(chainId: string, token: string): Promise<TokenMeta> {
    try {
      if (token === 'native') {
        const { nativeCurrency } = await this.chains.getChain(chainId);
        return {
          decimals: nativeCurrency.decimals,
          symbol: nativeCurrency.symbol,
        };
      }
      const api = await this.transactionApis.getApi(chainId);
      const t = RawTokenSchema.parse(await api.getToken(getAddress(token)));
      if (t.type !== 'ERC20') return { reason: 'not_erc20' };
      // the gateway token schema turns absent decimals into 0: never guess
      if (t.decimals === null || t.decimals === undefined) {
        return { reason: 'token_decimals_unknown' };
      }
      return { decimals: t.decimals, symbol: t.symbol };
    } catch (error) {
      if (error instanceof DataSourceError && error.code === 404) {
        return { reason: 'unknown_token' };
      }
      throw new BadGatewayException('Could not read token details');
    }
  }

  private async insertItems(
    em: EntityManager,
    run: PayoutRunRow,
    items: Array<PreparedItem>,
    trusted: ReadonlySet<string>,
  ): Promise<void> {
    const calls = itemCalls(items.map(asItemRow));
    const evaluation = await this.evaluateCalls(em, run, calls, trusted);
    const warnings = await this.itemWarnings(em, run, items, evaluation);
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

  /** Policy check of the transaction the UI will build; not logged (a preview). */
  private async evaluateCalls(
    em: EntityManager,
    run: PayoutRunRow,
    calls: ReadonlyArray<SafeCall>,
    trusted: ReadonlySet<string>,
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
      trusted,
    );
    // any trusted MultiSend unpacks the same; none known → evaluate reports it as undecodable
    const multiSend = ([...trusted][0] ?? zeroAddress) as Address;
    return evaluate(policies, outerTx(calls, multiSend), ctx);
  }

  /** Per item, in input order. */
  private async itemWarnings(
    em: EntityManager,
    run: PayoutRunRow,
    items: ReadonlyArray<{ recipient: string; token: string }>,
    evaluation: Evaluation,
  ): Promise<Array<Array<PayoutItemWarning>>> {
    const contacts: Array<{ address: string }> = await em.query(
      `SELECT lower(address::text) AS address FROM contacts
        WHERE org_id = $1 AND chain_ids @> ARRAY[$2::text]`,
      [run.org_id, run.chain_id],
    );
    const known = new Set(contacts.map((c) => c.address));
    const key = (i: { recipient: string; token: string }): string =>
      `${i.recipient}:${i.token}`;
    const seen = new Map<string, number>();
    for (const i of items) seen.set(key(i), (seen.get(key(i)) ?? 0) + 1);
    const flagged = new Set<number>();
    if (evaluation.status === 'violation') {
      for (const v of evaluation.violations) {
        const index = itemIndex(v.callPath, items.length);
        if (index !== null) flagged.add(index);
      }
    }
    return items.map((i, index) => {
      const w: Array<PayoutItemWarning> = [];
      if (!known.has(i.recipient)) w.push('unknown_recipient');
      if (seen.get(key(i))! > 1) w.push('duplicate');
      if (i.recipient === run.safe_address) w.push('self');
      if (i.recipient === i.token) w.push('token_contract');
      if (flagged.has(index)) w.push('policy');
      return w;
    });
  }

  /** Per token, Σ amounts against the Safe's balance; HTTP, so never inside a transaction. */
  private async runWarnings(
    chainId: string,
    safeAddress: string,
    items: ReadonlyArray<PayoutItemView>,
  ): Promise<Array<PayoutRunWarning>> {
    const sums = new Map<
      string,
      { raw: bigint; decimals: number; symbol: string; token: string }
    >();
    for (const i of items) {
      const key = i.token.toLowerCase();
      const s = sums.get(key) ?? {
        raw: 0n,
        decimals: i.decimals,
        symbol: i.symbol,
        token: i.token,
      };
      s.raw += parseAmountStrict(i.amount, i.decimals);
      sums.set(key, s);
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
    for (const [key, s] of sums) {
      const required = formatAmount(s.raw, s.decimals);
      if (available === null) {
        out.push({
          code: 'balance_unknown',
          token: s.token,
          symbol: s.symbol,
          required,
        });
        continue;
      }
      // a token missing from the list is held at 0
      const has = available.get(key) ?? 0n;
      if (has < s.raw) {
        out.push({
          code: 'insufficient_balance',
          token: s.token,
          symbol: s.symbol,
          required,
          available: formatAmount(has, s.decimals),
        });
      }
    }
    return out;
  }

  private async read(
    em: EntityManager,
    orgId: string,
    runId: string,
    userId: string,
  ): Promise<{ run: PayoutRunView; items: Array<PayoutItemView> }> {
    const [r]: Array<PayoutRunRow & { linked_safe_id: string | null }> =
      await em.query(
        `SELECT ${RUN_COLUMNS},
                (SELECT ls.id FROM linked_safes ls
                  WHERE ls.org_id = r.org_id AND ls.chain_id = r.chain_id
                    AND ls.address = r.safe_address) AS linked_safe_id
           FROM payout_runs r WHERE r.org_id = $1 AND r.id = $2`,
        [orgId, runId],
      );
    if (!r) throw new NotFoundException('Payout run not found');
    const items = await readItems(em, orgId, runId);
    const [a]: Array<{
      id: string;
      status: PayoutAttemptView['status'];
      nonce: string;
      created_by: string | null;
      created_at: Date;
    }> = await em.query(
      `SELECT id, status, nonce::text AS nonce, created_by, created_at
         FROM payout_proposal_attempts WHERE org_id = $1 AND run_id = $2
        ORDER BY created_at DESC, id DESC LIMIT 1`,
      [orgId, runId],
    );
    let latestAttempt: PayoutAttemptView | null = null;
    if (a) {
      // the claimer or payouts.manage may release an open or reported attempt (B8)
      const open =
        (r.status === 'proposing' || r.status === 'proposed') &&
        a.status !== 'released';
      const releasable =
        open &&
        (a.created_by === userId ||
          !!(
            await this.resolver.effective(orgId, userId, em)
          )?.permissions.includes('payouts.manage'));
      latestAttempt = {
        id: a.id,
        status: a.status,
        nonce: a.nonce,
        createdBy: a.created_by,
        createdAt: a.created_at.toISOString(),
        releasable,
      };
    }
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
        evaluation: r.evaluation,
        safeTxHash: r.safe_tx_hash,
        nonce: r.nonce,
        executedTxHash: r.executed_tx_hash,
        review: r.review,
        pinnedNonce: r.pinned_nonce,
        verifyingSince: r.verifying_since?.toISOString() ?? null,
        delayNotified: r.delay_notified_at !== null,
        latestAttempt,
      },
      items: items.map((i) => ({
        id: i.id,
        line: i.line_no,
        recipient: getAddress(i.recipient),
        name: i.name,
        token: i.token === 'native' ? 'native' : getAddress(i.token),
        symbol: i.symbol,
        decimals: i.decimals,
        amount: i.amount,
        warnings: i.warnings,
      })),
    };
  }

  /** Unlocked read for the HTTP done before a mutation; the mutation re-reads under the lock. */
  private async peek(orgId: string, runId: string): Promise<PayoutRunRow> {
    const [run]: Array<PayoutRunRow> = await this.tx.runInOrgTx(
      (em) =>
        em.query(
          `SELECT ${RUN_COLUMNS} FROM payout_runs WHERE org_id = $1 AND id = $2`,
          [orgId, runId],
        ),
      orgId,
    );
    if (!run) throw new NotFoundException('Payout run not found');
    // fail early, before any HTTP; rechecked under the lock
    this.assertEditable(run);
    return run;
  }

  private assertEditable(run: PayoutRunRow): void {
    if (!EDITABLE_STATUSES.includes(run.status)) {
      throw conflict('run_locked', LOCKED_MESSAGE);
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

  private event(
    em: EntityManager,
    type: 'payout_run.created' | 'payout_run.updated' | 'payout_run.deleted',
    run: PayoutRunRow,
    items: number,
    actor: Actor,
  ): Promise<void> {
    return this.log.record(em, {
      orgId: run.org_id,
      actorUserId: actor.userId,
      type,
      targetType: 'payout_run',
      targetId: run.id,
      payload: {
        name: run.name,
        chainId: run.chain_id,
        address: getAddress(run.safe_address),
        items,
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
