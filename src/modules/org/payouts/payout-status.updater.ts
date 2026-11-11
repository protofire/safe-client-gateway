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
  callsMismatch,
  multiSendCallOnlySet,
  verifyProposedTx,
} from '@/modules/org/payouts/payout-verify';
import type { StoredCall } from '@/modules/org/payouts/payout.schemas';
import { mapLimit } from '@/modules/org/safes/map-limit';
import type { MultisigTransaction } from '@/modules/safe/domain/entities/multisig-transaction.entity';
import type { Transfer } from '@/modules/safe/domain/entities/transfer.entity';
import { ISafeRepository } from '@/modules/safe/domain/safe.repository.interface';

const MINUTE = 60_000;
const INTERVAL_MS = 2 * MINUTE;
const BOOT_DELAY_MS = MINUTE;
const DEADLINE_MS = 24 * 60 * MINUTE;
const PAGE = 100;
const MAX_TRANSFER_PAGES = 10;
const SAFE_CONCURRENCY = 5;
// two-int4 advisory key space: never collides with the per-Safe bigint locks
const RUN_LOCK = [0x6f7267, 3] as const;

/** What the tx-service says about the pinned nonce N; read before any transaction (HTTP). */
export type NonceEvidence = {
  nonce: bigint;
  currentNonce: bigint;
  /** N used: the tx executed at N, if the tx-service lists it. */
  executed: MultisigTransaction | null;
  /** N unused: queued txs at N (adoption candidates). */
  queued: Array<MultisigTransaction>;
  /** ERC20 transfers of the executed tx, read only when it carries the run's calls. */
  transfers: Array<Transfer>;
  callOnly: ReadonlySet<string>;
  trusted: ReadonlySet<string>;
};

const lower = (a: string): string => a.toLowerCase();

/**
 * Moves pinned payout runs along the canonical lifecycle: while N is unused,
 * a proposing run adopts a matching tx queued at N; once N is used, B7
 * `settlementOutcome`. Every 2 min (lock `[0x6f7267, 3]`) and right after an
 * executed-transaction event. Each run is handled in its own transaction:
 * run row lock, then the Safe lock — the order claims use too.
 */
@Injectable()
export class PayoutStatusUpdater
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private timer: NodeJS.Timeout | undefined;
  private bootTimer: NodeJS.Timeout | undefined;
  /** Runs being handled; a request for one of them is skipped (the next pass picks it up). */
  private readonly inFlight = new Set<string>();

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
          for (const r of runs) await this.handleSafely(r.org_id, r.run_id);
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
      await this.handleSafely(r.org_id, r.run_id, safeTxHash);
    }
  }

  /** One run: evidence read without a DB connection, then applied under the locks. */
  async handle(orgId: string, runId: string): Promise<void> {
    const [peek]: Array<{
      chain_id: string;
      safe_address: string;
      pinned_nonce: string | null;
      calls: Array<StoredCall> | null;
    }> = await this.tx.runInOrgTx(
      (em) =>
        em.query(
          `SELECT chain_id, safe_address::text AS safe_address, pinned_nonce::text AS pinned_nonce, calls
             FROM payout_runs WHERE org_id = $1 AND id = $2`,
          [orgId, runId],
        ),
      orgId,
    );
    if (!peek || peek.pinned_nonce === null) return;
    const evidence = await this.readEvidence(
      peek.chain_id,
      peek.safe_address,
      BigInt(peek.pinned_nonce),
      peek.calls && fromStoredCalls(peek.calls),
    );
    await this.tx.runInOrgTx(async (em) => {
      const run = await lockRun(em, orgId, runId);
      await lockSafe(em, run.chain_id, run.safe_address);
      await this.apply(em, run, evidence);
    }, orgId);
  }

  /** HTTP only: the Safe nonce, the txs at N, the transfers of the run's own execution, MultiSend sets. */
  async readEvidence(
    chainId: string,
    address: string,
    nonce: bigint,
    /** The run's current calls: transfers are read only for an execution of them. */
    calls: ReadonlyArray<SafeCall> | null,
  ): Promise<NonceEvidence> {
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
    const used = BigInt(currentNonce) > nonce;
    const [page, callOnly, trusted] = await Promise.all([
      this.safes.getMultisigTransactions({
        chainId,
        safeAddress,
        nonce: nonce.toString(),
        executed: used,
        limit: PAGE,
      }),
      this.callOnly(chainId),
      this.policies.trustedMultiSend(chainId),
    ]);
    // the server filters are not trusted
    const txs = page.results.filter(
      (t) =>
        t.isExecuted === used &&
        BigInt(t.nonce) === nonce &&
        lower(t.safe) === lower(safeAddress),
    );
    const executed = used ? (txs[0] ?? null) : null;
    const ownExecution =
      executed?.transactionHash &&
      calls !== null &&
      callsMismatch(executed, calls, callOnly) === null;
    return {
      nonce,
      currentNonce: BigInt(currentNonce),
      executed,
      queued: used ? [] : txs,
      transfers: ownExecution
        ? await this.readTransfers(
            chainId,
            safeAddress,
            executed.transactionHash!,
          )
        : [],
      callOnly,
      trusted,
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
   * run's current pin: N unused → adoption (proposing runs only); N used →
   * settlement.
   */
  async apply(
    em: EntityManager,
    run: PayoutRunRow,
    ev: NonceEvidence,
  ): Promise<void> {
    if (run.pinned_nonce === null || BigInt(run.pinned_nonce) !== ev.nonce)
      return; // the pin changed after the read: the next pass reads again
    if (ev.currentNonce > ev.nonce) return this.settle(em, run, ev);
    if (run.status === 'proposing') await this.adopt(em, run, ev);
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

  /** Skips a run already being handled: the running pass or the next periodic one sees the newer state. */
  private async handleSafely(
    orgId: string,
    runId: string,
    safeTxHash?: string,
  ): Promise<void> {
    if (this.inFlight.has(runId)) return;
    this.inFlight.add(runId);
    try {
      await this.handle(orgId, runId);
    } catch (error) {
      this.logger.warn({
        type: 'payout_status_run_failed',
        orgId,
        runId,
        safeTxHash,
        error: message(error),
      });
    } finally {
      this.inFlight.delete(runId);
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
          limit: PAGE,
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
    return out;
  }

  /** A queued tx at N that passes `verifyProposedTx` against the current calls is treated like a report of the open attempt. */
  private async adopt(
    em: EntityManager,
    run: PayoutRunRow,
    ev: NonceEvidence,
  ): Promise<void> {
    if (run.calls === null) return;
    const calls = fromStoredCalls(run.calls);
    const match = ev.queued.find(
      (t) =>
        verifyProposedTx(
          t,
          { safeAddress: getAddress(run.safe_address), nonce: ev.nonce, calls },
          ev.callOnly,
        ).ok,
    );
    if (!match) return;
    const [open]: Array<{ id: string }> = await em.query(
      `SELECT id FROM payout_proposal_attempts WHERE org_id = $1 AND run_id = $2 AND status = 'open'`,
      [run.org_id, run.id],
    );
    if (open)
      await this.markProposed(em, run, open.id, lower(match.safeTxHash));
  }

  private async settle(
    em: EntityManager,
    run: PayoutRunRow,
    ev: NonceEvidence,
  ): Promise<void> {
    const items = await readItems(em, run.org_id, run.id);
    const attempts: Array<{ calls: Array<StoredCall> }> = await em.query(
      `SELECT calls FROM payout_proposal_attempts WHERE org_id = $1 AND run_id = $2 AND nonce = $3`,
      [run.org_id, run.id, run.pinned_nonce],
    );
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
      executedAtNonce: ev.executed,
      transfers: ev.transfers,
      trusted: ev.trusted,
      callOnly: ev.callOnly,
      now,
      deadline,
    });
    // pending: N is used but the execution is not visible or decided yet; at the deadline no transfer is proven
    if (outcome.status === 'pending' && deadline !== null && now >= deadline)
      outcome = {
        status: 'needs_review',
        review: { reason: 'missing_transfers' },
        ...(ev.executed?.transactionHash && {
          executedTxHash: ev.executed.transactionHash,
        }),
      };
    if (outcome.status === 'pending' || outcome.status === 'verifying')
      return this.markVerifying(em, run, now, outcome.executedTxHash ?? null);
    await this.finish(em, run, outcome, ev, items.length);
  }

  private async markVerifying(
    em: EntityManager,
    run: PayoutRunRow,
    now: Date,
    executedTxHash: string | null,
  ): Promise<void> {
    if (run.status === 'verifying' && run.executed_tx_hash === executedTxHash)
      return;
    // entering `verifying` is a status change (version + 1)
    await em.query(
      `UPDATE payout_runs
          SET status = 'verifying', verifying_since = COALESCE(verifying_since, $3),
              executed_tx_hash = $4,
              version = version + CASE WHEN status = 'verifying' THEN 0 ELSE 1 END,
              updated_at = now()
        WHERE org_id = $1 AND id = $2`,
      [run.org_id, run.id, now, executedTxHash],
    );
  }

  /**
   * A final outcome: pin cleared, open attempt released (`nonce_used`), watch
   * row gone, `payout_run.settled`. An execution of the run's own calls
   * records its safeTxHash (the one that executed, reported or not).
   */
  private async finish(
    em: EntityManager,
    run: PayoutRunRow,
    outcome: Settlement,
    ev: NonceEvidence,
    itemCount: number,
  ): Promise<void> {
    const own =
      ev.executed !== null &&
      run.calls !== null &&
      callsMismatch(ev.executed, fromStoredCalls(run.calls), ev.callOnly) ===
        null;
    const safeTxHash = own ? lower(ev.executed!.safeTxHash) : run.safe_tx_hash;
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
    await em.query(`DELETE FROM payout_watch WHERE run_id = $1`, [run.id]);
    await this.event(em, run, 'payout_run.settled', {
      name: run.name,
      status: outcome.status,
      safeTxHash,
      ...(outcome.executedTxHash && { executedTxHash: outcome.executedTxHash }),
      items: itemCount,
      ...(outcome.review && { review: outcome.review }),
    });
  }

  private event(
    em: EntityManager,
    run: PayoutRunRow,
    type:
      | 'payout_run.proposed'
      | 'payout_run.proposal_released'
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

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
