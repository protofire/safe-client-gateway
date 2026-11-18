import type { MultisigTransaction } from '@/modules/safe/domain/entities/multisig-transaction.entity';
import type { LinkedSafeRow } from '@/modules/org/safes/linked-safes.service';
import type { HistoryKey } from '@/modules/org/safes/transactions/cursor';
import {
  compareHistoryKey,
  historyKey,
  historyPage,
  type HistoryPage,
  type HistoryReader,
} from '@/modules/org/safes/transactions/history-merge';
import { toRow } from '@/modules/org/safes/transactions/row';
import type { Kind } from '@/modules/org/safes/transactions/tx-kind';
import {
  T0,
  executed,
  linked,
  settingsData,
  txService,
} from '@/modules/org/safes/transactions/__tests__/model';

type Db = Map<string, Array<MultisigTransaction>>;

const label = (
  safes: ReadonlyArray<LinkedSafeRow>,
  r: { linkedSafeId: string; nonce: number },
): string => `${safes.find((s) => s.id === r.linkedSafeId)?.id}${r.nonce}`;

/** Every executed row with a time, in the total order, kind-filtered. */
function oracle(
  safes: ReadonlyArray<LinkedSafeRow>,
  db: Db,
  kind?: ReadonlyArray<Kind>,
): Array<string> {
  return safes
    .flatMap((s) =>
      (db.get(s.id) ?? [])
        .filter((tx) => tx.executionDate !== null)
        .map((tx) => toRow(s, tx, 'history')),
    )
    .filter((r) => !kind?.length || kind.includes(r.kind))
    .sort((a, b) => compareHistoryKey(historyKey(a), historyKey(b)))
    .map((r) => label(safes, r));
}

async function pageAll(
  safes: ReadonlyArray<LinkedSafeRow>,
  read: HistoryReader,
  opts: { limit: number; window: number; kind?: ReadonlyArray<Kind> },
  between?: (page: number) => void,
): Promise<Array<HistoryPage>> {
  const pages: Array<HistoryPage> = [];
  let after: HistoryKey | null = null;
  do {
    const page = await historyPage({ safes, read, after, ...opts });
    pages.push(page);
    after = page.nextKey;
    between?.(pages.length);
    if (pages.length > 200) throw new Error('no progress');
  } while (after !== null);
  return pages;
}

const labels = (
  safes: ReadonlyArray<LinkedSafeRow>,
  pages: ReadonlyArray<HistoryPage>,
): Array<Array<string>> =>
  pages.map((p) => p.items.map((r) => label(safes, r)));

describe('historyPage', () => {
  it('regression A: one Safe resumes by nonceLt across same-second rows (W=2, limit=2; passes without the frontier)', async () => {
    const A = linked('A', '1', 1);
    const B = linked('B', '1', 2);
    const T = T0;
    const db: Db = new Map([
      [
        'A',
        [
          executed(A, 10, T),
          executed(A, 9, T),
          executed(A, 8, T),
          executed(A, 7, T - 1),
        ],
      ],
      ['B', [executed(B, 0, T - 2)]],
    ]);
    const { read } = txService(db);

    const pages = await pageAll([A, B], read, { limit: 2, window: 2 });

    expect(labels([A, B], pages)).toEqual([
      ['A10', 'A9'],
      ['A8', 'A7'],
      ['B0'],
    ]);
  });

  it.each([2, 100])(
    'regression F: same-second rows at the page boundary continue by nonce before an older Safe (W=%i, limit=25)',
    async (window) => {
      const A = linked('A', '1', 1);
      const B = linked('B', '1', 2);
      const T = T0 + 1_000;
      const a: Array<MultisigTransaction> = [];
      // 24 newer rows, then two at T (rows 25 and 26), then 30 older ones
      for (let i = 0; i < 24; i++) a.push(executed(A, 100 - i, T + 24 - i));
      a.push(executed(A, 76, T), executed(A, 75, T));
      for (let i = 0; i < 30; i++) a.push(executed(A, 74 - i, T - 1 - i));
      const db: Db = new Map([
        ['A', a],
        ['B', [executed(B, 0, T - 500)]],
      ]);
      const { read } = txService(db);

      const pages = await pageAll([A, B], read, { limit: 25, window });

      const got = labels([A, B], pages);
      if (window === 100) {
        // page 1 ends on the first row at T; page 2 resumes A by nonceLt
        expect(got[0][24]).toBe('A76');
        expect(got[1][0]).toBe('A75');
      } else {
        // W=2: each page stops at the frontier after 1 read + 3 refills (8 rows of A)
        expect(got.slice(0, -1).every((p) => p.length === 8)).toBe(true);
      }
      expect(got.flat()).toEqual(oracle([A, B], db));
      expect(got.flat().at(-1)).toBe('B0');
    },
  );

  it('3 Safes, interleaved times: no skips, no repeats (W=2, limit=3)', async () => {
    const safes = [
      linked('A', '1', 1),
      linked('B', '1', 2),
      linked('C', '5', 1),
    ];
    const db: Db = new Map(
      safes.map((s, k) => [
        s.id,
        Array.from({ length: 8 }, (_, i) =>
          executed(s, 20 - i, T0 - i * 3 - k),
        ),
      ]),
    );
    const { read } = txService(db);

    const pages = await pageAll(safes, read, { limit: 3, window: 2 });

    expect(labels(safes, pages).flat()).toEqual(oracle(safes, db));
  });

  it('commits only the emitted prefix: two Safes offer limit + 6 candidates each', async () => {
    const A = linked('A', '1', 1);
    const B = linked('B', '1', 2);
    const db: Db = new Map([
      [
        'A',
        Array.from({ length: 10 }, (_, i) => executed(A, 9 - i, T0 - 2 * i)),
      ],
      [
        'B',
        Array.from({ length: 10 }, (_, i) =>
          executed(B, 9 - i, T0 - 2 * i - 1),
        ),
      ],
    ]);
    const { read } = txService(db);
    const all = oracle([A, B], db);

    const page1 = await historyPage({
      safes: [A, B],
      read,
      after: null,
      limit: 4,
      window: 100,
    });
    const page2 = await historyPage({
      safes: [A, B],
      read,
      after: page1.nextKey,
      limit: 4,
      window: 100,
    });

    expect(labels([A, B], [page1, page2]).flat()).toEqual(all.slice(0, 8));
    expect(page1.nextKey).toEqual(historyKey(page1.items[3]));
  });

  it('multi-Safe with more than W rows each: W=2, limit=5, 21 rows once and in order, with refills', async () => {
    const safes = [
      linked('A', '1', 1),
      linked('B', '1', 2),
      linked('C', '1', 3),
    ];
    const db: Db = new Map(
      safes.map((s, k) => [
        s.id,
        Array.from({ length: 7 }, (_, i) => executed(s, 6 - i, T0 - i * 3 - k)),
      ]),
    );
    const model = txService(db);

    const pages = await pageAll(safes, model.read, { limit: 5, window: 2 });

    expect(labels(safes, pages).flat()).toEqual(oracle(safes, db));
    expect(labels(safes, pages).flat()).toHaveLength(21);
    expect(model.calls.some((c) => c.offset > 0)).toBe(true);
    // every page stops at or before its frontier
    for (const p of pages) {
      if (p.searchedUntil === null) continue;
      for (const r of p.items) {
        expect(Date.parse(r.executedAt!)).toBeGreaterThanOrEqual(
          Date.parse(p.searchedUntil),
        );
      }
    }
  });

  it('equal executedAt across and within Safes: a Safe before the cursor Safe reads T - 1 s and does not repeat', async () => {
    const A = linked('A', '1', 1);
    const B = linked('B', '1', 2);
    const T = T0;
    const db: Db = new Map([
      ['A', [executed(A, 5, T), executed(A, 4, T)]],
      ['B', [executed(B, 3, T), executed(B, 2, T)]],
    ]);
    const model = txService(db);

    const page1 = await historyPage({
      safes: [A, B],
      read: model.read,
      after: null,
      limit: 3,
      window: 100,
    });
    model.calls.length = 0;
    const page2 = await historyPage({
      safes: [A, B],
      read: model.read,
      after: page1.nextKey,
      limit: 3,
      window: 100,
    });

    expect(labels([A, B], [page1, page2])).toEqual([
      ['A5', 'A4', 'B3'],
      ['B2'],
    ]);
    expect(model.calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          safeId: 'A',
          executionDateLte: new Date((T - 1) * 1000).toISOString(),
        }),
        expect.objectContaining({ safeId: 'B', nonceLt: 3 }),
      ]),
    );
    expect(page2.nextKey).toBeNull();
  });

  it('a failed refill keeps the previous frontier; the next page continues without a skip', async () => {
    const A = linked('A', '1', 1);
    const B = linked('B', '1', 2);
    const db: Db = new Map([
      ['A', Array.from({ length: 6 }, (_, i) => executed(A, 6 - i, T0 - i))],
      ['B', [executed(B, 0, T0 - 100)]],
    ]);
    const model = txService(db);
    let failRefill = true;
    model.failWhen = (_, q): boolean => failRefill && q.offset > 0;

    const page1 = await historyPage({
      safes: [A, B],
      read: model.read,
      after: null,
      limit: 5,
      window: 2,
    });
    failRefill = false;
    const rest = await pageAll([A, B], model.read, { limit: 5, window: 2 });

    expect(labels([A, B], [page1])).toEqual([['A6', 'A5']]);
    expect(page1.nextKey).toEqual(historyKey(page1.items[1]));
    expect(page1.unavailableSafeIds).toEqual([]);
    const page2 = await historyPage({
      safes: [A, B],
      read: model.read,
      after: page1.nextKey,
      limit: 5,
      window: 2,
    });
    expect(labels([A, B], [page1, page2]).flat()).toEqual(
      labels([A, B], rest).flat().slice(0, 7),
    );
  });

  it('zero-match windows: kind=settings scans 8 rows per request and moves back until it finds the row', async () => {
    const A = linked('A', '1', 1);
    const txs = Array.from({ length: 20 }, (_, i) =>
      executed(A, 21 - i, T0 - i),
    );
    txs.push(
      executed(A, 1, T0 - 50, {
        to: A.address,
        data: settingsData,
        value: '0',
      }),
    );
    const model = txService(new Map([['A', txs]]));
    const opts = {
      safes: [A],
      read: model.read,
      limit: 25,
      window: 2,
      kind: ['settings'] as Array<Kind>,
    };

    const p1 = await historyPage({ ...opts, after: null });
    const reads1 = model.calls.length;
    const p2 = await historyPage({ ...opts, after: p1.nextKey });
    const reads2 = model.calls.length - reads1;
    const p3 = await historyPage({ ...opts, after: p2.nextKey });

    expect(reads1).toBe(4);
    expect(reads2).toBe(4);
    expect(p1.items).toEqual([]);
    expect(p1.nextKey).not.toBeNull();
    expect(p2.items).toEqual([]);
    expect(p2.nextKey).not.toBeNull();
    expect(Date.parse(p2.searchedUntil!)).toBeLessThan(
      Date.parse(p1.searchedUntil!),
    );
    expect(p3.items.map((r) => [r.nonce, r.kind])).toEqual([[1, 'settings']]);
    expect(p3.nextKey).toBeNull();
  });

  it('same block at limit=1: seven pages, one row each, every nonce', async () => {
    const A = linked('A', '1', 1);
    const db: Db = new Map([
      ['A', Array.from({ length: 7 }, (_, i) => executed(A, 7 - i, T0))],
    ]);
    const { read } = txService(db);

    const pages = await pageAll([A], read, { limit: 1, window: 2 });

    expect(labels([A], pages)).toEqual([
      ['A7'],
      ['A6'],
      ['A5'],
      ['A4'],
      ['A3'],
      ['A2'],
      ['A1'],
    ]);
  });

  it('frontier rule: never emits a row after a non-exhausted Safe’s examined key; nextCursor = F when short', async () => {
    const A = linked('A', '1', 1);
    const B = linked('B', '1', 2);
    const db: Db = new Map([
      ['A', Array.from({ length: 10 }, (_, i) => executed(A, 10 - i, T0 - i))],
      [
        'B',
        Array.from({ length: 10 }, (_, i) => executed(B, 10 - i, T0 - 50 - i)),
      ],
    ]);
    const { read } = txService(db);

    const page = await historyPage({
      safes: [A, B],
      read,
      after: null,
      limit: 10,
      window: 2,
    });

    // 1 read + 3 refills of A = 8 rows; B's rows sort after F and stay unemitted
    expect(labels([A, B], [page])).toEqual([
      ['A10', 'A9', 'A8', 'A7', 'A6', 'A5', 'A4', 'A3'],
    ]);
    expect(page.nextKey).toEqual(historyKey(page.items[7]));
    expect(page.searchedUntil).toBe(page.items[7].executedAt);
  });

  it('orders chainId numerically (10 < 56 < 100 < 8453) at the same time', async () => {
    const safes = ['8453', '100', '56', '10'].map((c, i) =>
      linked(`S${c}-`, c, i + 1),
    );
    const db: Db = new Map(safes.map((s) => [s.id, [executed(s, 0, T0)]]));
    const { read } = txService(db);

    const page = await historyPage({
      safes,
      read,
      after: null,
      limit: 10,
      window: 2,
    });

    expect(page.items.map((r) => r.chainId)).toEqual([
      '10',
      '56',
      '100',
      '8453',
    ]);
  });

  it('drops a row with a null executionDate and never uses it as a key', async () => {
    const A = linked('A', '1', 1);
    const db: Db = new Map([
      ['A', [executed(A, 5, T0), executed(A, 4, null), executed(A, 3, T0 - 1)]],
    ]);
    const { read } = txService(db);

    const pages = await pageAll([A], read, { limit: 1, window: 2 });

    expect(labels([A], pages)).toEqual([['A5'], ['A3']]);
    expect(pages.every((p) => p.nextKey === null || p.nextKey.n !== 4)).toBe(
      true,
    );
  });

  it('reads on past a full window of untimed rows: the timed older row is never lost (W=2)', async () => {
    const A = linked('A', '1', 1);
    const db: Db = new Map([
      [
        'A',
        [executed(A, 5, null), executed(A, 4, null), executed(A, 3, T0 - 1)],
      ],
    ]);
    const { read, calls } = txService(db);

    const pages = await pageAll([A], read, { limit: 1, window: 2 });

    expect(labels([A], pages)).toEqual([['A3']]);
    expect(pages.flatMap((p) => p.unavailableSafeIds)).toEqual([]);
    expect(calls.map((c) => c.offset)).toEqual([0, 2]);
  });

  it('still reports a Safe unavailable when its untimed rows outlast the refills', async () => {
    const A = linked('A', '1', 1);
    const db: Db = new Map([
      ['A', Array.from({ length: 12 }, (_, i) => executed(A, 20 - i, null))],
    ]);
    const { read, calls } = txService(db);

    const page = await historyPage({
      safes: [A],
      read,
      after: null,
      limit: 5,
      window: 2,
    });

    expect(page.unavailableSafeIds).toEqual(['A']);
    expect(page.items).toEqual([]);
    expect(calls).toHaveLength(4);
  });

  it('lists a failed execution and an on-chain rejection', async () => {
    const A = linked('A', '1', 1);
    const db: Db = new Map([
      [
        'A',
        [
          executed(A, 2, T0, { isSuccessful: false }),
          executed(A, 1, T0 - 1, { to: A.address, value: '0', data: null }),
        ],
      ],
    ]);
    const { read } = txService(db);

    const page = await historyPage({
      safes: [A],
      read,
      after: null,
      limit: 5,
      window: 100,
    });

    expect(page.items.map((r) => [r.nonce, r.status, r.kind])).toEqual([
      [2, 'failed', 'transfer'],
      [1, 'executed', 'rejection'],
    ]);
    expect(page.items.every((r) => !r.awaitingMe && !r.conflict)).toBe(true);
  });

  it('a new execution between pages shows only after a reset, with no duplicates', async () => {
    const A = linked('A', '1', 1);
    const B = linked('B', '1', 2);
    const db: Db = new Map([
      [
        'A',
        Array.from({ length: 4 }, (_, i) => executed(A, 4 - i, T0 - 2 * i)),
      ],
      [
        'B',
        Array.from({ length: 4 }, (_, i) => executed(B, 4 - i, T0 - 2 * i - 1)),
      ],
    ]);
    const before = oracle([A, B], db);
    const { read } = txService(db);

    const pages = await pageAll([A, B], read, { limit: 3, window: 2 }, (n) => {
      if (n === 1) {
        db.get('A')!.push(executed(A, 5, T0 + 10));
        db.get('B')!.push(executed(B, 5, T0 + 11));
      }
    });
    const reset = await historyPage({
      safes: [A, B],
      read,
      after: null,
      limit: 3,
      window: 2,
    });

    expect(labels([A, B], pages).flat()).toEqual(before);
    expect(labels([A, B], [reset])[0]).toEqual(['B5', 'A5', before[0]]);
  });

  it('a failed first read makes the Safe unavailable; the others are listed', async () => {
    const A = linked('A', '1', 1);
    const B = linked('B', '1', 2);
    const db: Db = new Map([
      ['A', [executed(A, 1, T0)]],
      ['B', [executed(B, 1, T0 - 1)]],
    ]);
    const model = txService(db);
    model.failWhen = (id): boolean => id === 'A';

    const page = await historyPage({
      safes: [A, B],
      read: model.read,
      after: null,
      limit: 5,
      window: 100,
    });

    expect(page.unavailableSafeIds).toEqual(['A']);
    expect(labels([A, B], [page])).toEqual([['B1']]);
    expect(page.nextKey).toBeNull();
  });
});
