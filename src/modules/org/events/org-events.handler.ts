import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import type { Address } from 'viem';
import { ILoggingService, LoggingService } from '@/logging/logging.interface';
import { IBalancesRepository } from '@/modules/balances/domain/balances.repository.interface';
import type { ActivityEventType } from '@/modules/org/activity/activity-event-types';
import { ActivityLog } from '@/modules/org/activity/activity-log.service';
import { OrgTransaction } from '@/modules/org/db/org-transaction';
import { TransactionEventType } from '@/modules/hooks/routes/entities/event-type.entity';
import type { Event } from '@/modules/hooks/routes/entities/event.entity';
import {
  lockSafe,
  overwriteSnapshot,
  seedSnapshotIfAbsent,
  toSnapshot,
  type Snapshot,
} from '@/modules/org/events/safe-snapshot';
import { ISafeRepository } from '@/modules/safe/domain/safe.repository.interface';

type TxEvent = Extract<Event, { address: string; chainId: string }>;

const ZERO = '0x0000000000000000000000000000000000000000';
const lower = (a: string): string => a.toLowerCase();
const sameSet = (a: Array<string>, b: Array<string>): boolean =>
  a.length === b.length && a.every((x) => b.some((y) => lower(x) === lower(y)));
const minus = (a: Array<string>, b: Array<string>): Array<string> =>
  a.filter((x) => !b.some((y) => lower(x) === lower(y)));

async function readSnapshot(
  em: EntityManager,
  chainId: string,
  address: string,
): Promise<Snapshot | null> {
  const rows: Array<Snapshot> = await em.query(
    `SELECT owners, threshold, modules, guard, version
       FROM linked_safe_snapshots WHERE chain_id = $1 AND address = $2`,
    [chainId, address],
  );
  return rows[0] ?? null;
}

@Injectable()
export class OrgEventsHandler {
  constructor(
    @Inject(ISafeRepository) private readonly safeRepository: ISafeRepository,
    @Inject(IBalancesRepository)
    private readonly balancesRepository: IBalancesRepository,
    private readonly tx: OrgTransaction,
    private readonly activityLog: ActivityLog,
    @Inject(LoggingService) private readonly logger: ILoggingService,
  ) {}

  /** Throws on infrastructure failures (cache, node, DB): the consumer decides to retry. */
  async handle(event: Event): Promise<void> {
    if (!('address' in event) || !('chainId' in event)) return;
    const e = event as TxEvent;

    const isConfigCandidate =
      (e.type === TransactionEventType.EXECUTED_MULTISIG_TRANSACTION &&
        e.failed === 'false') ||
      e.type === TransactionEventType.MODULE_TRANSACTION;
    const isSeedOnly =
      e.type === TransactionEventType.PENDING_MULTISIG_TRANSACTION ||
      e.type === TransactionEventType.NEW_CONFIRMATION;

    const orgIds =
      isConfigCandidate || isSeedOnly
        ? await this.linkingOrgs(e.chainId, e.address)
        : [];
    if (orgIds.length === 0) {
      await this.invalidate(e);
      return;
    }
    await this.tx.runInOrgTx((em) =>
      this.process(em, e, orgIds, isConfigCandidate),
    );
  }

  /**
   * One Safe at a time: the lock is taken before the cache is cleared and
   * `getSafe` is read, so reads and diffs happen in the same order for
   * concurrent events and a diff can never be reversed. It holds one DB
   * connection during the node read (bounded by lock_timeout and the HTTP
   * timeouts); events of other Safes are not blocked.
   */
  private async process(
    em: EntityManager,
    e: TxEvent,
    orgIds: Array<string>,
    isConfigCandidate: boolean,
  ): Promise<void> {
    await lockSafe(em, e.chainId, e.address);
    await this.invalidate(e);

    const previous = await readSnapshot(em, e.chainId, e.address);
    if (!isConfigCandidate && previous !== null) return;

    if (isConfigCandidate) {
      const key = createHash('sha256')
        .update(
          `${e.chainId}|${lower(e.address)}|${lower(
            (e as { txHash: string }).txHash,
          )}|${e.type}`,
        )
        .digest('hex');
      const inserted: Array<unknown> = await em.query(
        `INSERT INTO processed_events (event_key) VALUES ($1)
         ON CONFLICT (event_key) DO NOTHING RETURNING event_key`,
        [key],
      );
      if (inserted.length === 0) return;
    }

    let current: Snapshot;
    try {
      current = toSnapshot(
        await this.safeRepository.getSafe({
          chainId: e.chainId,
          address: e.address,
        }),
      );
    } catch (error) {
      // a failed read for a seed-only event must not cost a retry
      if (!isConfigCandidate) {
        this.logger.warn({
          type: 'org_events_seed_failed',
          chainId: e.chainId,
          address: e.address,
        });
        return;
      }
      throw error;
    }

    if (previous === null) {
      // First sight: store, emit nothing (nothing to diff against)
      await seedSnapshotIfAbsent(em, e.chainId, e.address, current);
      return;
    }
    for (const orgId of orgIds) {
      await this.emitDiff(em, orgId, e, previous, current);
    }
    await overwriteSnapshot(em, e.chainId, e.address, current);
  }

  /**
   * Catches up on changes whose events were lost (dropped after the last
   * retry, consumer down): same lock and diff as `process`, from a fresh
   * `getSafe`. Seeds a Safe whose link-time seed failed, without events.
   * Throws on infrastructure failures; the caller logs and moves on.
   */
  async reconcile(chainId: string, address: Address): Promise<void> {
    const orgIds = await this.linkingOrgs(chainId, address);
    if (orgIds.length === 0) return;
    await this.tx.runInOrgTx(async (em) => {
      await lockSafe(em, chainId, address);
      // a missed event also missed its cache invalidation
      await this.safeRepository.clearSafe({ chainId, address });
      const previous = await readSnapshot(em, chainId, address);
      const current = toSnapshot(
        await this.safeRepository.getSafe({ chainId, address }),
      );
      if (previous === null) {
        await seedSnapshotIfAbsent(em, chainId, address, current);
        return;
      }
      const safe = { chainId, address };
      for (const orgId of orgIds) {
        await this.emitDiff(em, orgId, safe, previous, current, {
          source: 'reconcile',
        });
      }
      await overwriteSnapshot(em, chainId, address, current);
    });
  }

  private async emitDiff(
    em: EntityManager,
    orgId: string,
    safe: { chainId: string; address: string },
    prev: Snapshot,
    cur: Snapshot,
    extra: object = {},
  ): Promise<void> {
    const base = { chainId: safe.chainId, address: safe.address };
    const record = (type: ActivityEventType, payload: object): Promise<void> =>
      this.activityLog.record(em, {
        orgId,
        actorUserId: null,
        type,
        targetType: 'safe',
        targetId: safe.address,
        payload: { ...base, ...payload, ...extra },
      });

    if (!sameSet(prev.owners, cur.owners)) {
      await record('onchain.owners_changed', {
        from: prev.owners,
        to: cur.owners,
        added: minus(cur.owners, prev.owners),
        removed: minus(prev.owners, cur.owners),
      });
    }
    if (prev.threshold !== cur.threshold) {
      await record('onchain.threshold_changed', {
        from: prev.threshold,
        to: cur.threshold,
      });
    }
    if (!sameSet(prev.modules, cur.modules)) {
      await record('onchain.module_changed', {
        from: prev.modules,
        to: cur.modules,
        enabled: minus(cur.modules, prev.modules),
        disabled: minus(prev.modules, cur.modules),
      });
    }
    if (lower(prev.guard ?? ZERO) !== lower(cur.guard ?? ZERO)) {
      await record('onchain.guard_changed', {
        from: prev.guard,
        to: cur.guard,
      });
    }
  }

  private async linkingOrgs(
    chainId: string,
    address: string,
  ): Promise<Array<string>> {
    // linked_safes has no RLS on purpose (A3): cross-org fan-out
    const rows: Array<{ org_id: string }> = await this.tx.runInOrgTx((em) =>
      em.query(
        `SELECT org_id FROM linked_safes WHERE chain_id = $1 AND address = $2`,
        [chainId, address],
      ),
    );
    return rows.map((r) => r.org_id);
  }

  /**
   * Mirrors EventCacheHelper for the repositories the org layer reuses.
   * Collectibles and stakes caches are not served by the org app, so they
   * are deliberately not invalidated.
   */
  private async invalidate(e: TxEvent): Promise<void> {
    const a = { chainId: e.chainId, safeAddress: e.address };
    const s = this.safeRepository;
    const executed = [
      s.clearAllExecutedTransactions(a),
      s.clearMultisigTransactions(a),
    ];
    const txHash = (e as { safeTxHash?: string }).safeTxHash;
    const one = (): Promise<void> =>
      s.clearMultisigTransaction({
        chainId: e.chainId,
        safeTransactionHash: txHash as string,
      });
    const safe = (): Promise<void> =>
      s.clearSafe({ chainId: e.chainId, address: e.address });

    switch (e.type) {
      case TransactionEventType.PENDING_MULTISIG_TRANSACTION:
      case TransactionEventType.DELETED_MULTISIG_TRANSACTION:
      case TransactionEventType.NEW_CONFIRMATION:
        await Promise.all([s.clearMultisigTransactions(a), one()]);
        return;
      case TransactionEventType.EXECUTED_MULTISIG_TRANSACTION:
        await Promise.all([
          ...executed,
          s.clearTransfers(a),
          one(),
          safe(),
          this.balancesRepository.clearBalances(a),
        ]);
        return;
      case TransactionEventType.MODULE_TRANSACTION:
        await Promise.all([
          s.clearAllExecutedTransactions(a),
          s.clearModuleTransactions(a),
          safe(),
          this.balancesRepository.clearBalances(a),
        ]);
        return;
      case TransactionEventType.INCOMING_ETHER:
      case TransactionEventType.INCOMING_TOKEN:
        await Promise.all([
          ...executed,
          s.clearTransfers(a),
          s.clearIncomingTransfers(a),
          this.balancesRepository.clearBalances(a),
        ]);
        return;
      case TransactionEventType.OUTGOING_ETHER:
      case TransactionEventType.OUTGOING_TOKEN:
        await Promise.all([
          ...executed,
          s.clearTransfers(a),
          this.balancesRepository.clearBalances(a),
        ]);
        return;
      default:
        return;
    }
  }
}
