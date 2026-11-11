import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import { getAddress, type Address } from 'viem';
import { ILoggingService, LoggingService } from '@/logging/logging.interface';
import { IChainsRepository } from '@/modules/chains/domain/chains.repository.interface';
import { ActivityLog } from '@/modules/org/activity/activity-log.service';
import { Clock, type IClock } from '@/modules/org/common/clock';
import type { SafeCall } from '@/modules/org/common/multisend';
import { ORG_DATA_SOURCE } from '@/modules/org/db/org-data-source';
import { OrgTransaction } from '@/modules/org/db/org-transaction';
import { lockSafe } from '@/modules/org/events/safe-snapshot';
import type { Actor } from '@/modules/org/orgs/parse';
import { PolicyContextService } from '@/modules/org/policies/policy-context.service';
import {
  fromStoredCalls,
  lockRun,
  readItems,
  type PayoutRunRow,
} from '@/modules/org/payouts/payout-runs.service';
import {
  settlementOutcome,
  type Settlement,
} from '@/modules/org/payouts/payout-settlement';
import {
  callsEqual,
  callsMismatch,
  multiSendCallOnlySet,
  reorgMarginMs,
  verifyProposedTx,
} from '@/modules/org/payouts/payout-verify';
import type {
  PayoutRunStatus,
  StoredCall,
} from '@/modules/org/payouts/payout.schemas';
import { mapLimit } from '@/modules/org/safes/map-limit';
import type { MultisigTransaction } from '@/modules/safe/domain/entities/multisig-transaction.entity';
import type { Transfer } from '@/modules/safe/domain/entities/transfer.entity';
import { ISafeRepository } from '@/modules/safe/domain/safe.repository.interface';

const MINUTE = 60_000;
const INTERVAL_MS = 2 * MINUTE;
const BOOT_DELAY_MS = MINUTE;
const DELAY_NOTICE_MS = 10 * MINUTE;
const DEADLINE_MS = 24 * 60 * MINUTE;
const TRANSFER_PAGE = 100;
const QUEUED_PAGE = 100;
// tx-service execution dates vs our clock
const STRAY_SKEW_MS = 10 * MINUTE;
const MAX_QUEUED_PAGES = 5;
const MAX_TRANSFER_PAGES = 10;
const SAFE_CONCURRENCY = 5;
/** Periodic polls of a pinned draft with no released, unreported attempt at N: nothing of ours to adopt there. */
const IDLE_POLL_MS = 30 * MINUTE;
// two-int4 advisory key space: never collides with the per-Safe bigint locks
const RUN_LOCK = [0x6f7267, 3] as const;

/** What the tx-service says about the pinned nonce N; read before any transaction (HTTP). */
export type NonceEvidence = {
  nonce: bigint;
  currentNonce: bigint;
  /** The tx executed at N, read with the `executed` filter (not from a page of queued ones). */
  executed: MultisigTransaction | null;
  /** Queued txs at N (adoption candidates), up to {@link MAX_QUEUED_PAGES} pages. */
  queued: Array<MultisigTransaction>;
  /** Taken before any read: evidence older than a run's `verifying_since` cannot roll it back. */
  readAt: Date;
  /** Where copies of the run's calls could be: see {@link PayoutStatusUpdater.readStrayView}. */
  strayView: StrayView;
  /** ERC20/native transfers of the tx executed at N, as far as they could be read. */
  transfers: Array<Transfer>;
  callOnly: ReadonlySet<string>;
  trusted: ReadonlySet<string>;
};

const lower = (a: string): string => a.toLowerCase();

/** Queued txs from the Safe's current nonce (unsigned included) + executed ones since the run's first attempt; `complete` false = a read was capped. */
export type StrayView = {
  txs: Array<MultisigTransaction>;
  complete: boolean;
};

/**
 * Moves pinned payout runs along the canonical lifecycle once their nonce N
 * is used on-chain (or a matching proposal at N shows up): adoption, then
 * B7 `settlementOutcome`. Every 2 min (lock `[0x6f7267, 3]`) and right after
 * an executed-transaction event. Each run is handled in its own transaction:
 * run row lock, then the Safe lock — the order claims use too.
 */
@Injectable()
export class PayoutStatusUpdater
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private timer: NodeJS.Timeout | undefined;
  private bootTimer: NodeJS.Timeout | undefined;
  /** Per run: the handling in progress, and whether another was asked for meanwhile. */
  private readonly inFlight = new Map<
    string,
    { done: Promise<void>; again: boolean; idleBackoff: boolean }
  >();
  /** Run id → last periodic poll of it as an idle pinned draft. */
  // shortcut: per process; after a replica switch an idle draft is polled once early
  private readonly idlePolledAt = new Map<string, number>();

  constructor(
    @InjectDataSource(ORG_DATA_SOURCE) private readonly db: DataSource,
    private readonly tx: OrgTransaction,
    private readonly log: ActivityLog,
    private readonly policies: PolicyContextService,
    @Inject(ISafeRepository) private readonly safes: ISafeRepository,
    @Inject(IChainsRepository) private readonly chains: IChainsRepository,
    @Inject(Clock) private readonly clock: IClock,
    @Inject(LoggingService) private readonly logger: ILoggingService,
  ) {}

  onApplicationBootstrap(): void {
    const run = (): void => {
      this.run().catch((error: unknown) =>
        this.logger.error(`payout status run failed: ${message(error)}`),
      );
    };
    this.bootTimer = setTimeout(run, BOOT_DELAY_MS);
    this.bootTimer.unref();
    this.timer = setInterval(run, INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearTimeout(this.bootTimer);
    clearInterval(this.timer);
  }

  /** Returns the number of watched runs, or null if another replica holds the run lock. */
  async run(): Promise<number | null> {
    const runner = this.db.createQueryRunner();
    await runner.connect();
    try {
      const [{ locked }]: Array<{ locked: boolean }> = await runner.query(
        `SELECT pg_try_advisory_lock($1, $2) AS locked`,
        [...RUN_LOCK],
      );
      if (!locked) return null;
      try {
        // payout_watch has no RLS on purpose: cross-org fan-out
        const rows: Array<{ run_id: string; org_id: string; safe: string }> =
          await runner.query(
            `SELECT run_id, org_id, chain_id || ':' || safe_address AS safe FROM payout_watch`,
          );
        const bySafe = new Map<string, typeof rows>();
        for (const r of rows)
          bySafe.set(r.safe, [...(bySafe.get(r.safe) ?? []), r]);
        await mapLimit([...bySafe.values()], SAFE_CONCURRENCY, async (runs) => {
          for (const r of runs)
            await this.handleSafely(r.org_id, r.run_id, { idleBackoff: true });
        });
        return rows.length;
      } finally {
        await runner.query(`SELECT pg_advisory_unlock($1, $2)`, [...RUN_LOCK]);
      }
    } finally {
      await runner.release();
    }
  }

  /** Executed-transaction event of any Safe, linked or not: handles the runs watching it. */
  async onExecuted(
    chainId: string,
    safeAddress: string,
    safeTxHash: string,
  ): Promise<void> {
    const rows: Array<{ run_id: string; org_id: string }> =
      await this.tx.runInOrgTx((em) =>
        em.query(
          `SELECT run_id, org_id FROM payout_watch WHERE chain_id = $1 AND safe_address = $2`,
          [chainId, lower(safeAddress)],
        ),
      );
    for (const r of rows) {
      await this.handleSafely(r.org_id, r.run_id, { safeTxHash });
    }
  }

  /**
   * One run: evidence read without a DB connection, then applied under the
   * locks. `idleBackoff` (periodic pass): a pinned draft with no adoptable
   * attempt at N (released, never reported) is read at most every
   * {@link IDLE_POLL_MS}.
   */
  async handle(
    orgId: string,
    runId: string,
    opts: { idleBackoff?: boolean } = {},
  ): Promise<void> {
    const [peek]: Array<{
      chain_id: string;
      safe_address: string;
      status: PayoutRunStatus;
      pinned_nonce: string | null;
      first_attempt_at: Date | null;
      adoptable: boolean;
    }> = await this.tx.runInOrgTx(
      (em) =>
        em.query(
          `SELECT chain_id, safe_address::text AS safe_address, status, pinned_nonce::text AS pinned_nonce,
                  ${strayWindowStart('r.org_id', 'r.id', 'r.pinned_nonce')} AS first_attempt_at,
                  EXISTS (SELECT 1 FROM payout_proposal_attempts a
                    WHERE a.org_id = r.org_id AND a.run_id = r.id AND a.nonce = r.pinned_nonce
                      AND a.status = 'released' AND a.safe_tx_hash IS NULL) AS adoptable
             FROM payout_runs r WHERE org_id = $1 AND id = $2`,
          [orgId, runId],
        ),
      orgId,
    );
    if (!peek || peek.pinned_nonce === null) {
      this.idlePolledAt.delete(runId);
      return;
    }
    const idle = peek.status === 'draft' && !peek.adoptable;
    const now = this.clock.now().getTime();
    if (idle && opts.idleBackoff) {
      const last = this.idlePolledAt.get(runId);
      if (last !== undefined && now - last < IDLE_POLL_MS) return;
    }
    const evidence = await this.readEvidence(
      peek.chain_id,
      peek.safe_address,
      BigInt(peek.pinned_nonce),
      peek.first_attempt_at,
    );
    // read succeeded: back off only while N is unused (a used N settles or verifies the run)
    if (idle && evidence.currentNonce <= evidence.nonce)
      this.idlePolledAt.set(runId, now);
    else this.idlePolledAt.delete(runId);
    await this.tx.runInOrgTx(async (em) => {
      const run = await lockRun(em, orgId, runId);
      await lockSafe(em, run.chain_id, run.safe_address);
      await this.apply(em, run, evidence);
    }, orgId);
  }

  /** HTTP only: nonces, the txs at N, the transfers of the one executed at N, MultiSend sets. */
  async readEvidence(
    chainId: string,
    address: string,
    nonce: bigint,
    /** The run's first attempt: executed copies are looked for since then. */
    since: Date | null,
  ): Promise<NonceEvidence> {
    const readAt = this.clock.now();
    const safeAddress = getAddress(address);
    await Promise.all([
      this.safes.clearSafe({ chainId, address: safeAddress }),
      this.safes.clearMultisigTransactions({ chainId, safeAddress }),
      this.safes.clearTransfers({ chainId, safeAddress }),
    ]);
    const { currentNonce } = await this.safes.getNonces({
      chainId,
      safeAddress,
    });
    const [executedPage, queued] = await Promise.all([
      this.safes.getMultisigTransactions({
        chainId,
        safeAddress,
        nonce: nonce.toString(),
        executed: true,
        limit: 1,
      }),
      this.readQueued(chainId, safeAddress, { nonce: nonce.toString() }),
    ]);
    const strayView = await this.readStrayView(
      chainId,
      safeAddress,
      currentNonce,
      since,
    );
    const executed =
      executedPage.results.find(
        (t) =>
          t.isExecuted &&
          BigInt(t.nonce) === nonce &&
          lower(t.safe) === lower(safeAddress),
      ) ?? null;
    const [transfers, callOnly, trusted] = await Promise.all([
      executed?.transactionHash
        ? this.readTransfers(chainId, safeAddress, executed.transactionHash)
        : [],
      this.callOnly(chainId),
      this.policies.trustedMultiSend(chainId),
    ]);
    return {
      nonce,
      currentNonce: BigInt(currentNonce),
      executed,
      // adoption on a capped read just sees fewer candidates
      queued: queued.txs.filter((t) => BigInt(t.nonce) === nonce),
      readAt,
      strayView,
      transfers,
      callOnly,
      trusted,
    };
  }

  /**
   * The one view the stray rule reads at every decision point: queued txs
   * from the Safe's current nonce (unsigned included) and executed txs from
   * the run's first attempt (minus a clock skew; null: no attempt yet, none
   * needed). By time, not nonce: a copy may sit at a then-current nonce below N.
   */
  async readStrayView(
    chainId: string,
    safeAddress: Address,
    currentNonce: number | bigint,
    since: Date | null,
  ): Promise<StrayView> {
    const [queued, executed] = await Promise.all([
      this.readQueued(chainId, safeAddress, {
        nonceGte: Number(currentNonce),
        trusted: false,
      }),
      since === null
        ? { txs: [], complete: true }
        : this.readQueued(chainId, safeAddress, {
            executionDateGte: new Date(
              since.getTime() - STRAY_SKEW_MS,
            ).toISOString(),
            trusted: false,
            executed: true,
          }),
    ]);
    return {
      txs: [...queued.txs, ...executed.txs],
      complete: queued.complete && executed.complete,
    };
  }

  /**
   * Txs of the Safe matching `filter` (queued unless `executed: true`; trusted
   * only unless `trusted: false`), paged up to a cap; `complete` is false
   * when the cap cut the list short.
   */
  async readQueued(
    chainId: string,
    safeAddress: Address,
    filter: {
      nonce?: string;
      nonceGte?: number;
      trusted?: boolean;
      executed?: boolean;
      executionDateGte?: string;
    },
  ): Promise<{ txs: Array<MultisigTransaction>; complete: boolean }> {
    const executed = filter.executed ?? false;
    const out: Array<MultisigTransaction> = [];
    let complete = false;
    for (let page = 0; page < MAX_QUEUED_PAGES; page++) {
      const { results, next } = await this.safes.getMultisigTransactions({
        chainId,
        safeAddress,
        ...filter,
        executed,
        limit: QUEUED_PAGE,
        offset: out.length,
      });
      out.push(...results);
      if (next === null || results.length === 0) {
        complete = true;
        break;
      }
    }
    return {
      txs: out.filter(
        (t) =>
          t.isExecuted === executed && lower(t.safe) === lower(safeAddress),
      ),
      complete,
    };
  }

  async callOnly(chainId: string): Promise<ReadonlySet<string>> {
    const chain = await this.chains.getChain(chainId);
    return multiSendCallOnlySet(
      chainId,
      chain.contractAddresses.multiSendCallOnlyAddress ?? undefined,
    );
  }

  /**
   * Under the run row lock and the Safe lock, with evidence read for the
   * run's current pin: adoption for a pinned draft or proposing run, then
   * either the reorg check (N unused) or settlement (N used).
   */
  async apply(
    em: EntityManager,
    locked: PayoutRunRow,
    ev: NonceEvidence,
  ): Promise<void> {
    if (
      locked.pinned_nonce === null ||
      BigInt(locked.pinned_nonce) !== ev.nonce
    )
      return; // the pin changed after the read: the next pass reads again
    let run = locked;
    const consumed = ev.currentNonce > ev.nonce;
    if (run.status === 'draft' || run.status === 'proposing') {
      run = await this.adopt(em, run, ev, consumed);
    }
    if (!consumed) {
      // only evidence read after the run entered verifying may roll it back
      const stale =
        run.verifying_since !== null && run.verifying_since > ev.readAt;
      if (run.status === 'verifying' && !stale) await this.unverify(em, run);
      // periodic check while N is pinned and unused: a copy elsewhere could pay besides N
      if (
        (run.status === 'draft' ||
          run.status === 'proposing' ||
          run.status === 'proposed') &&
        ev.strayView.complete
      ) {
        const stray = findStray(
          ev.strayView.txs,
          ev.nonce,
          await knownCalls(em, run),
          ev.callOnly,
        );
        if (stray) await this.warnStray(em, run, stray);
        else if (run.review?.reason === 'stray_proposal')
          await em.query(
            `UPDATE payout_runs SET review = NULL, updated_at = now() WHERE org_id = $1 AND id = $2`,
            [run.org_id, run.id],
          );
      }
      return;
    }
    await this.settle(em, run, ev);
  }

  /** Report accepted (report route or adoption): attempt reported, run proposed. */
  async markProposed(
    em: EntityManager,
    run: PayoutRunRow,
    attemptId: string,
    safeTxHash: string,
    actor?: Actor,
  ): Promise<PayoutRunRow> {
    await em.query(
      `UPDATE payout_proposal_attempts
          SET status = 'reported', safe_tx_hash = $3, reported_at = now(), updated_at = now()
        WHERE org_id = $1 AND id = $2`,
      [run.org_id, attemptId, safeTxHash],
    );
    await em.query(
      `UPDATE payout_runs
          SET status = 'proposed', safe_tx_hash = $3, nonce = pinned_nonce,
              version = version + 1, updated_at = now()
        WHERE org_id = $1 AND id = $2`,
      [run.org_id, run.id, safeTxHash],
    );
    await this.event(
      em,
      run,
      'payout_run.proposed',
      { name: run.name, safeTxHash, nonce: run.pinned_nonce },
      actor,
    );
    return lockRun(em, run.org_id, run.id);
  }

  // ---- helpers ----

  /**
   * Coalesced per run: while one handling runs, any number of further
   * requests (events, the periodic pass) become one rerun after it, so a
   * burst of events never handles one run concurrently or N times.
   */
  private handleSafely(
    orgId: string,
    runId: string,
    opts: { safeTxHash?: string; idleBackoff?: boolean } = {},
  ): Promise<void> {
    const idleBackoff = opts.idleBackoff ?? false;
    const current = this.inFlight.get(runId);
    if (current) {
      current.again = true;
      // an event among the coalesced requests is never backed off
      current.idleBackoff &&= idleBackoff;
      return current.done;
    }
    const entry = { done: Promise.resolve(), again: false, idleBackoff };
    entry.done = (async (): Promise<void> => {
      try {
        do {
          const backoff = entry.idleBackoff;
          entry.again = false;
          entry.idleBackoff = true;
          await this.handleOnce(orgId, runId, opts.safeTxHash, backoff);
        } while (entry.again);
      } finally {
        this.inFlight.delete(runId);
      }
    })();
    this.inFlight.set(runId, entry);
    return entry.done;
  }

  private async handleOnce(
    orgId: string,
    runId: string,
    safeTxHash: string | undefined,
    idleBackoff: boolean,
  ): Promise<void> {
    try {
      await this.handle(orgId, runId, { idleBackoff });
    } catch (error) {
      this.logger.warn({
        type: 'payout_status_run_failed',
        orgId,
        runId,
        safeTxHash,
        error: message(error),
      });
    }
  }

  /** Pages of the executed tx's transfers; a failed or capped read just yields less evidence. */
  private async readTransfers(
    chainId: string,
    safeAddress: Address,
    transactionHash: string,
  ): Promise<Array<Transfer>> {
    const out: Array<Transfer> = [];
    for (let page = 0; page < MAX_TRANSFER_PAGES; page++) {
      try {
        const { results, next } = await this.safes.getTransfers({
          chainId,
          safeAddress,
          transactionHash,
          limit: TRANSFER_PAGE,
          // by what came back: the server may cap the page below `limit`
          offset: out.length,
        });
        out.push(...results);
        if (next === null || results.length === 0) break;
      } catch (error) {
        this.logger.warn({
          type: 'payout_transfers_read_failed',
          chainId,
          safeAddress,
          error: message(error),
        });
        break;
      }
    }
    // the server filter is not trusted
    return out.filter(
      (t) => lower(t.transactionHash) === lower(transactionHash),
    );
  }

  /**
   * A matching tx at N (passes `verifyProposedTx` against the current calls)
   * is treated like a report. Hashes of the run's released attempts are
   * skipped (no release/adopt loop); once N is used only the executed tx counts.
   */
  private async adopt(
    em: EntityManager,
    run: PayoutRunRow,
    ev: NonceEvidence,
    consumed: boolean,
  ): Promise<PayoutRunRow> {
    if (run.calls === null) return run;
    const calls = fromStoredCalls(run.calls);
    const attempts = await this.attempts(em, run);
    // a pinned draft was released on purpose: its released hashes are not re-adopted
    const skip = new Set(
      run.status === 'draft'
        ? attempts
            .filter((a) => a.status === 'released' && a.safe_tx_hash !== null)
            .map((a) => lower(a.safe_tx_hash!))
        : [],
    );
    // the stray rule: no adoption while a copy may exist at another nonce
    if (
      !ev.strayView.complete ||
      findStray(
        ev.strayView.txs,
        ev.nonce,
        await knownCalls(em, run),
        ev.callOnly,
      )
    )
      return run;
    const executedAtN = ev.executed ? [ev.executed] : [];
    const candidates = consumed ? executedAtN : ev.queued;
    const match = candidates.find(
      (t) =>
        !skip.has(lower(t.safeTxHash)) &&
        verifyProposedTx(
          t,
          { safeAddress: getAddress(run.safe_address), nonce: ev.nonce, calls },
          ev.callOnly,
        ).ok,
    );
    if (!match) return run;
    const taken: Array<unknown> = await em.query(
      `SELECT 1 FROM payout_runs WHERE org_id = $1 AND safe_tx_hash = $2 AND id <> $3`,
      [run.org_id, lower(match.safeTxHash), run.id],
    );
    if (taken.length > 0) return run;
    // proposing: its open attempt; a pinned draft: a released, never reported attempt at N with these calls
    const attempt =
      run.status === 'proposing'
        ? attempts.find((a) => a.status === 'open')
        : attempts.find(
            (a) =>
              a.status === 'released' &&
              a.safe_tx_hash === null &&
              BigInt(a.nonce) === ev.nonce &&
              sameCalls(fromStoredCalls(a.calls), calls),
          );
    if (!attempt) return run;
    return this.markProposed(em, run, attempt.id, lower(match.safeTxHash));
  }

  private async settle(
    em: EntityManager,
    run: PayoutRunRow,
    ev: NonceEvidence,
  ): Promise<void> {
    const items = await readItems(em, run.org_id, run.id);
    const attempts = (await this.attempts(em, run)).filter(
      (a) => BigInt(a.nonce) === ev.nonce,
    );
    const executed = ev.executed;
    const now = this.clock.now();
    const deadline = run.verifying_since
      ? new Date(run.verifying_since.getTime() + DEADLINE_MS)
      : null;
    let outcome = settlementOutcome({
      run: {
        chainId: run.chain_id,
        safeAddress: getAddress(run.safe_address),
        calls: run.calls ? fromStoredCalls(run.calls) : null,
        items: items.map((i) => ({
          line: i.line_no,
          recipient: getAddress(i.recipient),
          token: i.token === 'native' ? 'native' : getAddress(i.token),
          amountRaw: BigInt(i.amount_raw),
        })),
      },
      attemptCalls: attempts.map((a) => fromStoredCalls(a.calls)),
      executedAtNonce: executed,
      transfers: ev.transfers,
      trusted: ev.trusted,
      callOnly: ev.callOnly,
      now,
      deadline,
    });
    if (outcome.status === 'pending') {
      // N is used but the execution is not visible or not decided yet: wait, never forever
      const executedTxHash = executed?.transactionHash ?? undefined;
      outcome =
        deadline !== null && now >= deadline
          ? {
              status: 'needs_review',
              review: { reason: 'undecodable' },
              ...(executedTxHash && { executedTxHash }),
            }
          : { status: 'verifying', ...(executedTxHash && { executedTxHash }) };
    }
    if (FINAL_STATUSES.includes(outcome.status)) {
      // the stray rule: a copy of the run's calls at another nonce could pay (again)
      const executedTxHash = outcome.executedTxHash;
      const view = ev.strayView;
      const stray = view.complete
        ? findStray(view.txs, ev.nonce, await knownCalls(em, run), ev.callOnly)
        : undefined;
      if (!view.complete) {
        outcome =
          deadline !== null && now >= deadline
            ? {
                status: 'needs_review',
                review: { reason: 'stray_proposal', outcome: outcome.status },
                ...(executedTxHash && { executedTxHash }),
              }
            : {
                status: 'verifying',
                ...(executedTxHash && { executedTxHash }),
              };
      } else if (stray) {
        // the reviewer needs what happened at N and whether the copy already paid
        outcome = {
          status: 'needs_review',
          review: { ...strayReview(stray).review!, outcome: outcome.status },
          ...(executedTxHash && { executedTxHash }),
        };
      }
    } else if (outcome.status === 'needs_review') {
      // the stray rule for a review outcome: its reason is kept, the copy (if any) is added
      const view = ev.strayView;
      const stray = view.complete
        ? findStray(view.txs, ev.nonce, await knownCalls(em, run), ev.callOnly)
        : undefined;
      // an unreadable queue does not hold back a run that already needs review
      if (!view.complete || stray) {
        outcome = {
          ...outcome,
          review: {
            ...outcome.review!,
            ...(stray && {
              nonce: String(stray.nonce),
              safeTxHash: stray.safeTxHash,
              strayExecuted: stray.isExecuted,
            }),
            outcome: 'needs_review',
          },
        };
      }
    }
    if (outcome.status === 'verifying')
      return this.markVerifying(em, run, outcome, now, executed);
    // the run's own calls executed (maybe under another hash than the reported one)
    const ownTx =
      executed !== null &&
      run.calls !== null &&
      lower(executed.safe) === lower(run.safe_address) &&
      callsMismatch(executed, fromStoredCalls(run.calls), ev.callOnly) === null;
    await this.finish(em, run, outcome, ownTx ? executed : null, items.length);
  }

  /**
   * A proposed run stays proposed and tracked (its tx at N is still queued);
   * the copy is shown as `review` and logged once. Settlement later ends it
   * `needs_review stray_proposal`.
   */
  private async warnStray(
    em: EntityManager,
    run: PayoutRunRow,
    stray: MultisigTransaction,
  ): Promise<void> {
    const review = strayReview(stray).review!;
    // same copy, same state: already shown; queued → executed is news
    if (
      run.review?.reason === review.reason &&
      run.review.safeTxHash === review.safeTxHash &&
      (run.review.strayExecuted ?? false) === review.strayExecuted
    )
      return;
    await em.query(
      `UPDATE payout_runs SET review = $3::jsonb, updated_at = now() WHERE org_id = $1 AND id = $2`,
      [run.org_id, run.id, JSON.stringify(review)],
    );
    await this.event(em, run, 'payout_run.stray_detected', {
      name: run.name,
      safeTxHash: run.safe_tx_hash,
      nonce: run.pinned_nonce,
      strayNonce: review.nonce,
      straySafeTxHash: review.safeTxHash,
      strayExecuted: review.strayExecuted,
    });
  }

  private async markVerifying(
    em: EntityManager,
    run: PayoutRunRow,
    outcome: Settlement,
    now: Date,
    executed: MultisigTransaction | null,
  ): Promise<void> {
    const since = run.verifying_since ?? now;
    // the delay counts from the end of the reorg margin (verifying before it is expected)
    const delayFrom = executed?.executionDate
      ? executed.executionDate.getTime() + reorgMarginMs(run.chain_id)
      : since.getTime();
    const notify =
      run.delay_notified_at === null &&
      now.getTime() - delayFrom >= DELAY_NOTICE_MS;
    const executedTxHash = outcome.executedTxHash ?? null;
    if (
      run.status === 'verifying' &&
      !notify &&
      run.executed_tx_hash === executedTxHash
    )
      return;
    // `verifying` only moves forward; entering it is a status change (version + 1)
    await em.query(
      `UPDATE payout_runs
          SET status = 'verifying', verifying_since = $3, executed_tx_hash = $4,
              delay_notified_at = CASE WHEN $5::boolean THEN $6::timestamptz ELSE delay_notified_at END,
              version = version + CASE WHEN status = 'verifying' THEN 0 ELSE 1 END,
              updated_at = now()
        WHERE org_id = $1 AND id = $2`,
      [run.org_id, run.id, since, executedTxHash, notify, now],
    );
    if (notify) {
      await this.event(em, run, 'payout_run.verification_delayed', {
        name: run.name,
        safeTxHash: run.safe_tx_hash,
        executedTxHash,
      });
    }
  }

  /** Reorged out (Safe nonce back to ≤ N): back where it was before N was used. */
  private async unverify(em: EntityManager, run: PayoutRunRow): Promise<void> {
    await em.query(
      `UPDATE payout_runs
          SET status = $3, verifying_since = NULL, delay_notified_at = NULL,
              executed_tx_hash = NULL, version = version + 1, updated_at = now()
        WHERE org_id = $1 AND id = $2`,
      [run.org_id, run.id, await this.restingStatus(em, run)],
    );
  }

  /** The status a pinned run has while N is unused: proposed (reported tx), proposing (open attempt) or draft. */
  private async restingStatus(
    em: EntityManager,
    run: PayoutRunRow,
  ): Promise<PayoutRunStatus> {
    if (run.status !== 'verifying') return run.status;
    if (run.safe_tx_hash !== null) return 'proposed';
    const attempts = await this.attempts(em, run);
    return attempts.some((a) => a.status === 'open') ? 'proposing' : 'draft';
  }

  /**
   * A final outcome: pin cleared, open attempt released (`nonce_used`), watch
   * row gone, `payout_run.settled`. `ownTx`: the executed tx at N carrying the
   * run's calls; its safeTxHash is recorded, and a reported hash that differs
   * is kept in `review.reportedSafeTxHash`.
   */
  private async finish(
    em: EntityManager,
    run: PayoutRunRow,
    settlement: Settlement,
    ownTx: MultisigTransaction | null,
    itemCount: number,
  ): Promise<void> {
    let outcome = settlement;
    if (
      outcome.status === 'replaced' &&
      (await this.restingStatus(em, run)) === 'draft'
    ) {
      // a pinned draft N went to an unrelated tx: it only loses its pin
      await em.query(
        `UPDATE payout_runs
            SET status = 'draft', pinned_nonce = NULL, verifying_since = NULL,
                delay_notified_at = NULL, executed_tx_hash = NULL,
                version = version + 1, updated_at = now()
          WHERE org_id = $1 AND id = $2`,
        [run.org_id, run.id],
      );
      await this.unwatch(em, run);
      return;
    }
    let safeTxHash = ownTx ? lower(ownTx.safeTxHash) : run.safe_tx_hash;
    if (safeTxHash !== null && safeTxHash !== run.safe_tx_hash) {
      const taken: Array<unknown> = await em.query(
        `SELECT 1 FROM payout_runs WHERE org_id = $1 AND safe_tx_hash = $2 AND id <> $3`,
        [run.org_id, safeTxHash, run.id],
      );
      if (taken.length > 0) {
        // another run of the org records this tx: both cannot own one payment
        safeTxHash = run.safe_tx_hash;
        const stray =
          outcome.review?.reason === 'stray_proposal' ? outcome.review : {};
        outcome = {
          status: 'needs_review',
          // a stray copy found at settlement stays visible
          review: { ...stray, reason: 'partial_overlap' },
          ...(outcome.executedTxHash && {
            executedTxHash: outcome.executedTxHash,
          }),
        };
      } else if (run.safe_tx_hash !== null) {
        // H reported, H' executed: the record follows the chain, the warning keeps H
        outcome = {
          ...outcome,
          review: {
            ...(outcome.review ?? { reason: 'executed_other_hash' }),
            reportedSafeTxHash: run.safe_tx_hash,
          },
        };
      }
    }
    await em.query(
      `UPDATE payout_runs
          SET status = $3, executed_tx_hash = $4, review = $5::jsonb, safe_tx_hash = $6,
              nonce = pinned_nonce, pinned_nonce = NULL, version = version + 1, updated_at = now()
        WHERE org_id = $1 AND id = $2`,
      [
        run.org_id,
        run.id,
        outcome.status,
        outcome.executedTxHash ?? null,
        outcome.review ? JSON.stringify(outcome.review) : null,
        safeTxHash,
      ],
    );
    // UPDATE … RETURNING gives [rows, rowCount] in TypeORM's pg driver
    const [released]: [Array<{ id: string; nonce: string }>, number] =
      await em.query(
        `UPDATE payout_proposal_attempts
          SET status = 'released', release_reason = 'nonce_used', released_at = now(), updated_at = now()
        WHERE org_id = $1 AND run_id = $2 AND status = 'open'
        RETURNING id, nonce::text AS nonce`,
        [run.org_id, run.id],
      );
    for (const a of released) {
      await this.event(em, run, 'payout_run.proposal_released', {
        name: run.name,
        attemptId: a.id,
        nonce: a.nonce,
        reason: 'nonce_used',
      });
    }
    await this.unwatch(em, run);
    await this.event(em, run, 'payout_run.settled', {
      name: run.name,
      status: outcome.status,
      safeTxHash,
      ...(outcome.executedTxHash && { executedTxHash: outcome.executedTxHash }),
      items: itemCount,
      ...(outcome.review && { review: outcome.review }),
    });
  }

  private unwatch(em: EntityManager, run: PayoutRunRow): Promise<unknown> {
    return em.query(`DELETE FROM payout_watch WHERE run_id = $1`, [run.id]);
  }

  private attempts(
    em: EntityManager,
    run: PayoutRunRow,
  ): Promise<
    Array<{
      id: string;
      status: 'open' | 'reported' | 'released';
      nonce: string;
      calls: Array<StoredCall>;
      safe_tx_hash: string | null;
    }>
  > {
    return em.query(
      `SELECT id, status, nonce::text AS nonce, calls, safe_tx_hash
         FROM payout_proposal_attempts WHERE org_id = $1 AND run_id = $2
        ORDER BY created_at DESC, id DESC`,
      [run.org_id, run.id],
    );
  }

  private event(
    em: EntityManager,
    run: PayoutRunRow,
    type:
      | 'payout_run.proposed'
      | 'payout_run.proposal_released'
      | 'payout_run.verification_delayed'
      | 'payout_run.stray_detected'
      | 'payout_run.settled',
    payload: Record<string, unknown>,
    actor?: Actor,
  ): Promise<void> {
    return this.log.record(em, {
      orgId: run.org_id,
      actorUserId: actor?.userId ?? null,
      type,
      targetType: 'payout_run',
      targetId: run.id,
      payload,
      ip: actor?.ip,
      userAgent: actor?.userAgent,
    });
  }
}

const sameCalls = (
  a: ReadonlyArray<SafeCall>,
  b: ReadonlyArray<SafeCall>,
): boolean => a.length === b.length && a.every((c, i) => callsEqual(c, b[i]));

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The run's current calls and every attempt's calls: what a stray copy would carry. */
/** What a copy of the run would carry, and the txs other runs of the org own (identical payouts are not copies). */
export type KnownCalls = {
  calls: Array<Array<SafeCall>>;
  otherRuns: ReadonlySet<string>;
};

export async function knownCalls(
  em: EntityManager,
  run: Pick<PayoutRunRow, 'org_id' | 'id' | 'calls'>,
): Promise<KnownCalls> {
  const attempts: Array<{ calls: Array<StoredCall> }> = await em.query(
    `SELECT calls FROM payout_proposal_attempts WHERE org_id = $1 AND run_id = $2`,
    [run.org_id, run.id],
  );
  const others: Array<{ safe_tx_hash: string }> = await em.query(
    `SELECT safe_tx_hash FROM payout_runs
      WHERE org_id = $1 AND id <> $2 AND safe_tx_hash IS NOT NULL`,
    [run.org_id, run.id],
  );
  return {
    calls: [
      ...(run.calls ? [run.calls] : []),
      ...attempts.map((a) => a.calls),
    ].map(fromStoredCalls),
    otherRuns: new Set(others.map((o) => lower(o.safe_tx_hash))),
  };
}

/** A queued or executed tx at another nonce than `nonce` (null: any) carrying one of the known call lists. */
export function findStray(
  txs: ReadonlyArray<MultisigTransaction>,
  nonce: bigint | null,
  known: KnownCalls,
  callOnly: ReadonlySet<string>,
): MultisigTransaction | undefined {
  return txs.find(
    (t) =>
      (nonce === null || BigInt(t.nonce) !== nonce) &&
      // a copy that executed and reverted paid nothing
      !(t.isExecuted && t.isSuccessful === false) &&
      !known.otherRuns.has(lower(t.safeTxHash)) &&
      known.calls.some((calls) => callsMismatch(t, calls, callOnly) === null),
  );
}

/** Outcomes that end the watch; each passes the stray rule first. */
const FINAL_STATUSES: ReadonlyArray<Settlement['status']> = [
  'executed',
  'failed',
  'replaced',
  'rejected',
];

const strayReview = (stray: MultisigTransaction): Settlement => ({
  status: 'needs_review',
  review: {
    reason: 'stray_proposal',
    nonce: String(stray.nonce),
    safeTxHash: stray.safeTxHash,
    strayExecuted: stray.isExecuted,
  },
});

/**
 * SQL for when the run's first proposal attempt at its pin was claimed; when
 * unpinned (settled or lost pin), at the nonce of its most recent attempt, so
 * a copy executed after that pin was cleared is still found. NULL: no attempt.
 */
const strayWindowStart = (org: string, run: string, pin: string): string =>
  `(SELECT min(a.created_at) FROM payout_proposal_attempts a
     WHERE a.org_id = ${org} AND a.run_id = ${run}
       AND a.nonce = COALESCE(${pin}, (SELECT l.nonce FROM payout_proposal_attempts l
         WHERE l.org_id = ${org} AND l.run_id = ${run} ORDER BY l.created_at DESC, l.id DESC LIMIT 1)))`;

/** Start of the stray view's executed window: see {@link strayWindowStart}. */
export async function firstAttemptAt(
  em: EntityManager,
  run: Pick<PayoutRunRow, 'org_id' | 'id' | 'pinned_nonce'>,
): Promise<Date | null> {
  const [{ first }]: Array<{ first: Date | null }> = await em.query(
    `SELECT ${strayWindowStart('$1', '$2', '$3::numeric')} AS first`,
    [run.org_id, run.id, run.pinned_nonce],
  );
  return first;
}
