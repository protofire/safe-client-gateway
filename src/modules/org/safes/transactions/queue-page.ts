import type { Address } from 'viem';
import type { MultisigTransaction } from '@/modules/safe/domain/entities/multisig-transaction.entity';
import type { LinkedSafeRow } from '@/modules/org/safes/linked-safes.service';
import type { QueueKey } from '@/modules/org/safes/transactions/cursor';
import type { Kind } from '@/modules/org/safes/transactions/tx-kind';
import {
  awaitsSignatureFrom,
  compareSafe,
  compareText,
  dedupe,
  toRow,
  type MultisigRow,
} from '@/modules/org/safes/transactions/row';

export type Counts = { queued: number; awaitingMe: number; complete: boolean };

export type QueueSafeRead =
  | { safe: LinkedSafeRow; rows: Array<MultisigRow>; truncated: boolean }
  | { safe: LinkedSafeRow; failed: true };

export type QueuePage = {
  items: Array<MultisigRow>;
  /** key of the last emitted row when more rows follow, else null */
  nextKey: QueueKey | null;
  counts: Counts;
  complete: boolean;
  unavailableSafeIds: Array<string>;
  truncatedSafeIds: Array<string>;
};

/**
 * Rows of one Safe from its `getTransactionQueueBySubmission` page and the
 * live owners from `getSafe`; `truncated` when the tx-service has more.
 */
export function queueSafeRows(
  safe: LinkedSafeRow,
  owners: ReadonlyArray<Address>,
  page: { results: Array<MultisigTransaction>; next: string | null },
  wallets: ReadonlySet<string>,
): { rows: Array<MultisigRow>; truncated: boolean } {
  const myOwners = owners.filter((o) => wallets.has(o.toLowerCase()));
  const perNonce = new Map<number, number>();
  for (const tx of page.results) {
    perNonce.set(tx.nonce, (perNonce.get(tx.nonce) ?? 0) + 1);
  }
  const rows = page.results.map((tx) =>
    toRow(
      safe,
      tx,
      'queue',
      {
        awaitingMe: awaitsSignatureFrom(tx, myOwners),
        conflict: (perNonce.get(tx.nonce) ?? 0) > 1,
      },
      owners,
    ),
  );
  return { rows, truncated: page.next !== null };
}

export function queueKey(row: MultisigRow): QueueKey {
  return {
    t: row.submittedAt,
    c: row.chainId,
    a: row.safeAddress.toLowerCase(),
    h: row.safeTxHash.toLowerCase(),
  };
}

/** Total order: submittedAt desc, chainId asc (numeric), safeAddress asc, safeTxHash asc. */
export function compareQueueKey(x: QueueKey, y: QueueKey): number {
  const dt = Date.parse(y.t) - Date.parse(x.t);
  if (dt !== 0) return dt;
  const s = compareSafe(
    { chainId: x.c, address: x.a },
    { chainId: y.c, address: y.a },
  );
  if (s !== 0) return s;
  return compareText(x.h, y.h);
}

/** Spec 027 §5 Queue paging: a live keyset over the merged per-Safe reads. */
export function queuePage(
  reads: ReadonlyArray<QueueSafeRead>,
  q: {
    kind?: ReadonlyArray<Kind>;
    mine?: boolean;
    limit: number;
    after: QueueKey | null;
  },
): QueuePage {
  const unavailableSafeIds: Array<string> = [];
  const truncatedSafeIds: Array<string> = [];
  const all: Array<MultisigRow> = [];
  for (const r of reads) {
    if ('failed' in r) {
      unavailableSafeIds.push(r.safe.id);
      continue;
    }
    if (r.truncated) truncatedSafeIds.push(r.safe.id);
    all.push(...r.rows);
  }
  const merged = dedupe(
    all.sort((a, b) => compareQueueKey(queueKey(a), queueKey(b))),
  );
  const kinds = q.kind?.length ? new Set(q.kind) : null;
  const after = q.after;
  const rest = merged.filter(
    (r) =>
      (kinds === null || kinds.has(r.kind)) &&
      (q.mine !== true || r.awaitingMe) &&
      (after === null || compareQueueKey(queueKey(r), after) > 0),
  );
  const items = rest.slice(0, q.limit);
  return {
    items,
    nextKey: rest.length > q.limit ? queueKey(items[items.length - 1]) : null,
    counts: {
      queued: merged.length,
      awaitingMe: merged.filter((r) => r.awaitingMe).length,
      complete:
        unavailableSafeIds.length === 0 && truncatedSafeIds.length === 0,
    },
    complete: unavailableSafeIds.length === 0,
    unavailableSafeIds,
    truncatedSafeIds,
  };
}
