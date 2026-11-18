import type { MultisigTransaction } from '@/modules/safe/domain/entities/multisig-transaction.entity';
import type { LinkedSafeRow } from '@/modules/org/safes/linked-safes.service';
import { mapLimit } from '@/modules/org/safes/map-limit';
import { CONCURRENCY } from '@/modules/org/safes/overview.service';
import type { HistoryKey } from '@/modules/org/safes/transactions/cursor';
import type { Kind } from '@/modules/org/safes/transactions/tx-kind';
import {
  compareSafe,
  dedupe,
  toRow,
  type MultisigRow,
} from '@/modules/org/safes/transactions/row';

export type HistoryQuery = {
  executionDateLte?: string;
  nonceLt?: number;
  limit: number;
  offset: number;
};
export type HistoryReader = (
  safe: LinkedSafeRow,
  q: HistoryQuery,
) => Promise<{ results: Array<MultisigTransaction>; next: string | null }>;

export type HistoryPage = {
  items: Array<MultisigRow>;
  nextKey: HistoryKey | null;
  searchedUntil: string | null;
  unavailableSafeIds: Array<string>;
};

export function historyKey(row: MultisigRow): HistoryKey {
  return {
    t: row.executedAt ?? row.submittedAt,
    c: row.chainId,
    a: row.safeAddress.toLowerCase(),
    n: row.nonce,
  };
}

export function compareHistoryKey(x: HistoryKey, y: HistoryKey): number {
  const dt = Date.parse(y.t) - Date.parse(x.t);
  if (dt !== 0) return dt;
  const s = compareSafe(
    { chainId: x.c, address: x.a },
    { chainId: y.c, address: y.a },
  );
  if (s !== 0) return s;
  return y.n - x.n;
}

/** Spec 027 §5: W = 100, or 200 with a `kind` filter (tx-service max). */
export function historyWindow(kind?: ReadonlyArray<Kind>): number {
  return kind?.length ? 200 : 100;
}
export const MAX_REFILLS = 3;

type SafeState = {
  safe: LinkedSafeRow;
  filter: Omit<HistoryQuery, 'limit' | 'offset'>;
  offset: number;
  rows: Array<MultisigRow>;
  /** E_S: key of the last timed row read */
  examined: HistoryKey | null;
  exhausted: boolean;
};

/** Per-Safe filter returning exactly its rows that sort strictly after K. */
function filterAfter(
  safe: LinkedSafeRow,
  k: HistoryKey | null,
): SafeState['filter'] {
  if (k === null) return {};
  const side = compareSafe(safe, { chainId: k.c, address: k.a });
  if (side === 0) return { nonceLt: k.n };
  // execution times are whole seconds: "before T" is "<= T - 1 s"
  const t = Date.parse(k.t) - (side < 0 ? 1000 : 0);
  return { executionDateLte: new Date(t).toISOString() };
}

/**
 * Spec 027 §5 History paging: k-way merge on a time keyset with the frontier
 * rule. `read` is bound to `ISafeRepository.getMultisigTransactions`
 * (executed: true) by the caller, which also applies the per-Safe deadline
 * and the request budget: a read that throws counts as failed.
 */
export async function historyPage(args: {
  safes: ReadonlyArray<LinkedSafeRow>;
  read: HistoryReader;
  after: HistoryKey | null;
  limit: number;
  kind?: ReadonlyArray<Kind>;
  window: number;
}): Promise<HistoryPage> {
  const kinds = args.kind?.length ? new Set(args.kind) : null;
  const after = args.after;

  const load = async (s: SafeState): Promise<void> => {
    const page = await args.read(s.safe, {
      ...s.filter,
      limit: args.window,
      offset: s.offset,
    });
    s.offset += args.window;
    for (const tx of page.results) {
      // no block yet: no order key; it shows up once indexed
      if (tx.executionDate === null) continue;
      const row = toRow(s.safe, tx, 'history');
      s.rows.push(row);
      s.examined = historyKey(row);
    }
    s.exhausted = page.next === null;
  };

  const loaded = await mapLimit(args.safes, CONCURRENCY, async (safe) => {
    const s: SafeState = {
      safe,
      filter: filterAfter(safe, after),
      offset: 0,
      rows: [],
      examined: null,
      exhausted: false,
    };
    try {
      await load(s);
      // a full window of untimed rows gives no key: read on, same cap as the refills
      for (
        let i = 0;
        !s.exhausted && s.examined === null && i < MAX_REFILLS;
        i++
      ) {
        await load(s);
      }
    } catch {
      return null;
    }
    // shortcut: still no timed row after the refills, so no key; unreadable until its blocks are indexed
    if (!s.exhausted && s.examined === null) return null;
    return s;
  });
  const states = loaded.filter((s): s is SafeState => s !== null);
  const unavailableSafeIds = args.safes
    .filter((_, i) => loaded[i] === null)
    .map((s) => s.id);

  /** F: the earliest-sorting examined key among non-exhausted Safes; null = "end" */
  const frontier = (): { safe: SafeState; key: HistoryKey } | null => {
    let best: { safe: SafeState; key: HistoryKey } | null = null;
    for (const s of states) {
      if (s.exhausted || s.examined === null) continue;
      if (best === null || compareHistoryKey(s.examined, best.key) < 0) {
        best = { safe: s, key: s.examined };
      }
    }
    return best;
  };
  const matching = (F: HistoryKey | null): Array<MultisigRow> =>
    dedupe(
      states
        .flatMap((s) => s.rows)
        .filter(
          (r) =>
            (kinds === null || kinds.has(r.kind)) &&
            (F === null || compareHistoryKey(historyKey(r), F) <= 0),
        )
        .sort((a, b) => compareHistoryKey(historyKey(a), historyKey(b))),
    );

  let f = frontier();
  let rows = matching(f?.key ?? null);
  for (
    let refills = 0;
    f !== null && rows.length < args.limit && refills < MAX_REFILLS;
    refills++
  ) {
    try {
      await load(f.safe);
    } catch {
      // a failed refill keeps the previous F (load changed nothing); the page stops there
      break;
    }
    f = frontier();
    rows = matching(f?.key ?? null);
  }

  const items = rows.slice(0, args.limit);
  const F = f?.key ?? null;
  let nextKey: HistoryKey | null = null;
  if (items.length === args.limit && (F !== null || rows.length > args.limit)) {
    nextKey = historyKey(items[items.length - 1]);
  } else if (F !== null) {
    nextKey = F;
  }
  return {
    items,
    nextKey,
    searchedUntil: F?.t ?? null,
    unavailableSafeIds,
  };
}
