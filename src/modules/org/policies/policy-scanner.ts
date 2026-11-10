import { createHash } from 'node:crypto';
import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import type { Address } from 'viem';
import { DataSourceError } from '@/domain/errors/data-source.error';
import { ILoggingService, LoggingService } from '@/logging/logging.interface';
import { ActivityLog } from '@/modules/org/activity/activity-log.service';
import { ORG_DATA_SOURCE } from '@/modules/org/db/org-data-source';
import { OrgTransaction } from '@/modules/org/db/org-transaction';
import { lockSafe } from '@/modules/org/events/safe-snapshot';
import {
  evaluate,
  type EvalContext,
  type Violation,
} from '@/modules/org/policies/evaluate';
import { PolicyContextService } from '@/modules/org/policies/policy-context.service';
import type { CompiledPolicy } from '@/modules/org/policies/policy-rules';
import { mapLimit } from '@/modules/org/safes/map-limit';
import { readQueue } from '@/modules/org/safes/queue-reader';
import type { MultisigTransaction } from '@/modules/safe/domain/entities/multisig-transaction.entity';
import { ISafeRepository } from '@/modules/safe/domain/safe.repository.interface';

const INTERVAL_MS = 5 * 60 * 1000;
const BOOT_DELAY_MS = 60 * 1000;
const FLUSH_DELAY_MS = 2000;
// queue page, missed-finding recheck and scanTxs write chunk: bounds work under lockSafe
const PAGE = 100;
const MAX_PENDING_PER_SAFE = 500;
// org pool max is 20 and shared with the API; no connection is held across HTTP
export const SCAN_CONCURRENCY = 5;
const READ_CONCURRENCY = 5;
// two-int4 advisory key space, next to the reconciler's [0x6f7267, 1]
const RUN_LOCK = [0x6f7267, 2] as const;

type Linked = { orgId: string; linkedSafeId: string };
/** `tx` null: executed, removed from the tx-service or replaced at its nonce. */
type Item = { safeTxHash: string; tx: MultisigTransaction | null };

/**
 * Warn-only policy check of queued transactions. Reads the tx-service outside
 * any transaction, then writes findings under the per-Safe lock. Each org
 * linking the Safe evaluates its own policies (RLS switched per org).
 * Findings are deduplicated by evaluation hash, so `policy.violation_found`
 * is logged once per new, changed or reopened violation set.
 */
@Injectable()
export class PolicyScanner implements OnApplicationBootstrap, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;
  private bootTimer: NodeJS.Timeout | undefined;
  private readonly pending = new Map<
    string,
    {
      chainId: string;
      address: Address;
      hashes: Set<string>;
      dropped: number;
    }
  >();
  private readonly flushing = new Set<string>();
  private readonly flushTimers = new Set<NodeJS.Timeout>();

  constructor(
    @InjectDataSource(ORG_DATA_SOURCE) private readonly db: DataSource,
    @Inject(ISafeRepository) private readonly safes: ISafeRepository,
    private readonly tx: OrgTransaction,
    private readonly context: PolicyContextService,
    private readonly activityLog: ActivityLog,
    @Inject(LoggingService) private readonly logger: ILoggingService,
  ) {}

  onApplicationBootstrap(): void {
    const run = (): void => {
      this.run().catch((error: unknown) =>
        this.logger.error(`policy scan failed: ${message(error)}`),
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
    for (const t of this.flushTimers) clearTimeout(t);
  }

  /** Returns the number of Safes scanned, or null if another run holds the lock. */
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
        // linked_safes has no RLS on purpose (A3)
        const safes: Array<{ chainId: string; address: Address }> =
          await runner.query(
            `SELECT DISTINCT chain_id AS "chainId", address FROM linked_safes`,
          );
        await mapLimit(
          safes,
          SCAN_CONCURRENCY,
          async ({ chainId, address }) => {
            try {
              await this.scanSafe(chainId, address);
            } catch (error) {
              this.logger.warn({
                type: 'policy_scan_safe_failed',
                chainId,
                address,
                error: message(error),
              });
            }
          },
        );
        return safes.length;
      } finally {
        await runner.query(`SELECT pg_advisory_unlock($1, $2)`, [...RUN_LOCK]);
      }
    } finally {
      await runner.release();
    }
  }

  /**
   * One page of 100 trusted queued txs from the stored offset. A failed read
   * throws, stamps `last_error_at` and changes nothing else. When the page
   * ends a pass, up to 100 open findings not seen since the pass started are
   * rechecked directly ({@link scanTxs}): offsets shift as queued txs execute,
   * so a pass can skip a tx.
   */
  async scanSafe(chainId: string, address: Address): Promise<void> {
    if (!(await this.covered(chainId, address))) return;
    try {
      await this.scanPage(chainId, address);
    } catch (error) {
      // policy_scan_state has no RLS (fan-out index); B9 shows it
      await this.db
        .query(
          `INSERT INTO policy_scan_state (chain_id, address, last_error_at) VALUES ($1, $2, now())
           ON CONFLICT (chain_id, address) DO UPDATE SET last_error_at = now()`,
          [chainId, address],
        )
        .catch(() => undefined);
      throw error;
    }
  }

  private async scanPage(chainId: string, address: Address): Promise<void> {
    // DB clock, stamped before any tx-service read: a write never undoes a later resolve
    const [{ read_at: readAt, next_offset }]: Array<{
      read_at: Date;
      next_offset: number | null;
    }> = await this.db.query(
      `SELECT clock_timestamp() AS read_at,
              (SELECT next_offset FROM policy_scan_state WHERE chain_id = $1 AND address = $2) AS next_offset`,
      [chainId, address],
    );
    const offset = next_offset ?? 0;
    const trusted = await this.context.trustedMultiSend(chainId);
    const safe = await this.safes.getSafe({ chainId, address });
    // unsigned proposals are not shown as policy warnings (anyone may post them)
    const { queued, nextOffset } = await readQueue(this.safes, chainId, safe, {
      offset,
      max: PAGE,
      trusted: true,
    });

    const missed = await this.tx.runInOrgTx(async (em) => {
      await lockSafe(em, chainId, address);
      const [{ pass_started_at }]: Array<{ pass_started_at: Date | null }> =
        await em.query(
          `INSERT INTO policy_scan_state (chain_id, address, next_offset, pass_started_at, last_success_at)
           VALUES ($1, $2, $3, CASE WHEN $4 THEN now() END, now())
           ON CONFLICT (chain_id, address) DO UPDATE SET
             next_offset = EXCLUDED.next_offset,
             pass_started_at = CASE WHEN $4 THEN now() ELSE policy_scan_state.pass_started_at END,
             last_success_at = now()
           RETURNING pass_started_at`,
          [chainId, address, nextOffset ?? 0, offset === 0],
        );
      const orgs = await this.linking(em, chainId, address);
      await this.apply(em, orgs, { chainId, address }, trusted, {
        readAt,
        safeNonce: safe.nonce,
        items: queued.map((tx) => ({
          safeTxHash: tx.safeTxHash.toLowerCase(),
          tx,
        })),
      });
      if (nextOffset !== null || pass_started_at === null) return [];
      const hashes = new Set<string>();
      for (const { orgId, linkedSafeId } of orgs) {
        await setOrg(em, orgId);
        const rows: Array<{ safe_tx_hash: string }> = await em.query(
          `SELECT safe_tx_hash FROM policy_findings
            WHERE org_id = $1 AND linked_safe_id = $2 AND resolved_at IS NULL
              AND last_seen_at < $3
            ORDER BY coalesce(last_rechecked_at, last_seen_at), id LIMIT ${PAGE}`,
          [orgId, linkedSafeId, pass_started_at],
        );
        rows.forEach((r) => hashes.add(r.safe_tx_hash));
      }
      return [...hashes].slice(0, PAGE);
    });
    if (missed.length > 0) await this.scanTxs(chainId, address, missed);
  }

  /**
   * Evaluates the named txs by direct read, at most 100 per transaction.
   * Executed, removed (404) or below the Safe nonce → resolved; a failed read
   * keeps the finding; an untrusted (unsigned) proposal is skipped. Open
   * findings below the Safe nonce are resolved without reading them.
   */
  async scanTxs(
    chainId: string,
    address: Address,
    safeTxHashes: ReadonlyArray<string>,
  ): Promise<void> {
    const hashes = [...new Set(safeTxHashes.map((h) => h.toLowerCase()))];
    if (hashes.length === 0) return;
    if (!(await this.covered(chainId, address))) return;
    const [{ read_at: readAt }]: Array<{ read_at: Date }> = await this.db.query(
      `SELECT clock_timestamp() AS read_at`,
    );
    const trusted = await this.context.trustedMultiSend(chainId);
    // without the Safe nonce a tx replaced at its nonce just stays open
    const safeNonce = await this.safes
      .getSafe({ chainId, address })
      .then((s) => s.nonce)
      .catch(() => null);
    for (let i = 0; i < hashes.length; i += PAGE) {
      const chunk = hashes.slice(i, i + PAGE);
      const reads = await mapLimit(chunk, READ_CONCURRENCY, (safeTxHash) =>
        this.readTx(chainId, address, safeTxHash, safeNonce),
      );
      const items = reads.filter((r): r is Item => r !== null);
      await this.tx.runInOrgTx(async (em) => {
        await lockSafe(em, chainId, address);
        const orgs = await this.linking(em, chainId, address);
        await this.apply(em, orgs, { chainId, address }, trusted, {
          readAt,
          safeNonce,
          items,
          rechecked: chunk,
        });
      });
    }
  }

  private async readTx(
    chainId: string,
    address: Address,
    safeTxHash: string,
    safeNonce: number | null,
  ): Promise<Item | null> {
    try {
      const tx = await this.safes.getMultiSigTransaction({
        chainId,
        safeTransactionHash: safeTxHash,
      });
      if (tx.safe.toLowerCase() !== address.toLowerCase()) return null;
      // not a trusted queued tx (any more): nothing to warn about
      if (!tx.trusted) return { safeTxHash, tx: null };
      const gone =
        tx.isExecuted || (safeNonce !== null && tx.nonce < safeNonce);
      return { safeTxHash, tx: gone ? null : tx };
    } catch (error) {
      if (error instanceof DataSourceError && error.code === 404) {
        return { safeTxHash, tx: null };
      }
      this.logger.warn({
        type: 'policy_scan_tx_failed',
        chainId,
        address,
        safeTxHash,
        error: message(error),
      });
      return null;
    }
  }

  /**
   * Before any upstream read: resolves the open findings of every linking
   * org without an active covering policy. False when no org has one (the
   * Safe needs no reads at all).
   */
  private covered(chainId: string, address: Address): Promise<boolean> {
    return this.tx.runInOrgTx(async (em) => {
      await lockSafe(em, chainId, address);
      let any = false;
      for (const org of await this.linking(em, chainId, address)) {
        await setOrg(em, org.orgId);
        const policies = await this.context.activePolicies(em, org.orgId, {
          chainId,
          address,
        });
        if (policies.length > 0) any = true;
        else await resolveAll(em, org);
      }
      return any;
    });
  }

  /**
   * Event path: collects hashes per Safe and calls {@link scanTxs} once,
   * 2 s after the first event; one flush per Safe at a time.
   */
  enqueue(chainId: string, address: Address, safeTxHash: string): void {
    const key = `${chainId}:${address.toLowerCase()}`;
    let entry = this.pending.get(key);
    if (!entry) {
      entry = { chainId, address, hashes: new Set(), dropped: 0 };
      this.pending.set(key, entry);
      if (!this.flushing.has(key)) this.schedule(key);
    }
    // the rest waits for the next timer pass
    const hash = safeTxHash.toLowerCase();
    if (entry.hashes.size < MAX_PENDING_PER_SAFE || entry.hashes.has(hash)) {
      entry.hashes.add(hash);
    } else {
      entry.dropped++;
    }
  }

  private schedule(key: string): void {
    const timer = setTimeout(() => {
      this.flushTimers.delete(timer);
      this.flush(key);
    }, FLUSH_DELAY_MS);
    timer.unref();
    this.flushTimers.add(timer);
  }

  private flush(key: string): void {
    const entry = this.pending.get(key);
    if (!entry) return;
    this.pending.delete(key);
    this.flushing.add(key);
    if (entry.dropped > 0) {
      this.logger.warn({
        type: 'policy_scan_pending_dropped',
        chainId: entry.chainId,
        address: entry.address,
        dropped: entry.dropped,
      });
    }
    this.scanTxs(entry.chainId, entry.address, [...entry.hashes])
      .catch((error: unknown) =>
        this.logger.warn({
          type: 'policy_scan_event_failed',
          chainId: entry.chainId,
          address: entry.address,
          error: message(error),
        }),
      )
      .finally(() => {
        this.flushing.delete(key);
        if (this.pending.has(key)) this.schedule(key);
      });
  }

  private async linking(
    em: EntityManager,
    chainId: string,
    address: string,
  ): Promise<Array<Linked>> {
    // linked_safes has no RLS on purpose (A3): cross-org fan-out
    return em.query(
      `SELECT org_id AS "orgId", id AS "linkedSafeId" FROM linked_safes
        WHERE chain_id = $1 AND address = $2 ORDER BY org_id`,
      [chainId, address],
    );
  }

  private async apply(
    em: EntityManager,
    orgs: Array<Linked>,
    safe: { chainId: string; address: Address },
    trusted: ReadonlySet<string>,
    read: {
      readAt: Date;
      safeNonce: number | null;
      items: Array<Item>;
      /** Hashes read by hash (failed reads included): rotates the bounded recheck. */
      rechecked?: Array<string>;
    },
  ): Promise<void> {
    for (const org of orgs) {
      await setOrg(em, org.orgId);
      const policies = await this.context.activePolicies(em, org.orgId, safe);
      if (policies.length === 0) {
        await resolveAll(em, org);
        continue;
      }
      if (read.rechecked?.length) {
        await em.query(
          `UPDATE policy_findings SET last_rechecked_at = clock_timestamp()
            WHERE org_id = $1 AND linked_safe_id = $2 AND safe_tx_hash = ANY($3)`,
          [org.orgId, org.linkedSafeId, read.rechecked],
        );
      }
      if (read.safeNonce !== null) {
        // a nonce below the Safe's can never execute any more
        await em.query(
          `UPDATE policy_findings SET resolved_at = clock_timestamp(), updated_at = now()
            WHERE org_id = $1 AND linked_safe_id = $2 AND resolved_at IS NULL AND nonce < $3`,
          [org.orgId, org.linkedSafeId, read.safeNonce],
        );
      }
      const ctx = await this.context.context(
        em,
        org.orgId,
        safe.chainId,
        trusted,
      );
      for (const item of read.items) {
        await this.check(em, org, safe, policies, ctx, item, read.readAt);
      }
    }
  }

  private async check(
    em: EntityManager,
    org: Linked,
    safe: { chainId: string; address: Address },
    policies: Array<CompiledPolicy>,
    ctx: EvalContext,
    { safeTxHash, tx }: Item,
    readAt: Date,
  ): Promise<void> {
    const result =
      tx &&
      evaluate(
        policies,
        {
          to: tx.to,
          value: BigInt(tx.value),
          data: tx.data ?? '0x',
          operation: tx.operation as 0 | 1,
        },
        ctx,
      );
    const key = [org.orgId, org.linkedSafeId, safeTxHash];
    if (!tx || result?.status !== 'violation') {
      await em.query(
        `UPDATE policy_findings SET resolved_at = clock_timestamp(), updated_at = now()
          WHERE org_id = $1 AND linked_safe_id = $2 AND safe_tx_hash = $3 AND resolved_at IS NULL`,
        key,
      );
      return;
    }
    const { violations } = result;
    // semantic content only: a new policy version or an unrelated policy edit
    // with the same violations is not news
    const evaluationHash = createHash('sha256')
      .update(
        JSON.stringify(
          violations.map((v) => [
            v.policyId,
            v.rule,
            v.callPath,
            v.to.toLowerCase(),
            v.detail,
          ]),
        ),
      )
      .digest('hex');
    const changed: Array<{ id: string }> = await em.query(
      `INSERT INTO policy_findings
         (org_id, linked_safe_id, safe_tx_hash, chain_id, safe_address, nonce, evaluation_hash, violations)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
       ON CONFLICT (org_id, linked_safe_id, safe_tx_hash) DO UPDATE SET
         violations = EXCLUDED.violations, evaluation_hash = EXCLUDED.evaluation_hash,
         nonce = EXCLUDED.nonce, resolved_at = NULL, last_seen_at = now(), updated_at = now()
       WHERE (policy_findings.resolved_at IS NULL
              AND policy_findings.evaluation_hash IS DISTINCT FROM EXCLUDED.evaluation_hash)
          OR policy_findings.resolved_at < $9
       RETURNING id`,
      [
        ...key,
        safe.chainId,
        safe.address,
        tx.nonce,
        evaluationHash,
        JSON.stringify(violations),
        readAt,
      ],
    );
    if (changed.length === 0) {
      // same news (or resolved after this read): keep stored versions current, never reopen
      await em.query(
        `UPDATE policy_findings SET violations = $4::jsonb, last_seen_at = now()
          WHERE org_id = $1 AND linked_safe_id = $2 AND safe_tx_hash = $3 AND resolved_at IS NULL`,
        [...key, JSON.stringify(violations)],
      );
      return;
    }
    await this.activityLog.record(em, {
      orgId: org.orgId,
      actorUserId: null,
      type: 'policy.violation_found',
      targetType: 'safe',
      targetId: safe.address,
      payload: {
        chainId: safe.chainId,
        address: safe.address,
        safeTxHash: tx.safeTxHash,
        nonce: tx.nonce,
        policies: violatingPolicies(policies, violations),
        rules: [...new Set(violations.map((v) => v.rule))],
      },
    });
  }
}

function violatingPolicies(
  policies: Array<CompiledPolicy>,
  violations: Array<Violation>,
): Array<{ id: string; name: string }> {
  const ids = new Set(violations.map((v) => v.policyId));
  return policies
    .filter((p) => ids.has(p.id))
    .map((p) => ({ id: p.id, name: p.name }));
}

function resolveAll(em: EntityManager, org: Linked): Promise<unknown> {
  return em.query(
    `UPDATE policy_findings SET resolved_at = clock_timestamp(), updated_at = now()
      WHERE org_id = $1 AND linked_safe_id = $2 AND resolved_at IS NULL`,
    [org.orgId, org.linkedSafeId],
  );
}

function setOrg(em: EntityManager, orgId: string): Promise<unknown> {
  return em.query(`SELECT set_config('app.org_id', $1, true)`, [orgId]);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
