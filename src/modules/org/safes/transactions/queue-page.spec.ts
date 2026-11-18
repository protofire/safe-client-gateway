import { getAddress, numberToHex, type Address } from 'viem';
import { confirmationBuilder } from '@/modules/safe/domain/entities/__tests__/multisig-transaction-confirmation.builder';
import type { MultisigTransaction } from '@/modules/safe/domain/entities/multisig-transaction.entity';
import type { LinkedSafeRow } from '@/modules/org/safes/linked-safes.service';
import {
  queuePage,
  queueSafeRows,
  type QueueSafeRead,
} from '@/modules/org/safes/transactions/queue-page';
import type { QueueKey } from '@/modules/org/safes/transactions/cursor';
import { dedupe, toRow } from '@/modules/org/safes/transactions/row';
import {
  T0,
  executed,
  linked,
  settingsData,
} from '@/modules/org/safes/transactions/__tests__/model';

const owner = (n: number): Address =>
  getAddress(numberToHex(0x1000 + n, { size: 20 }));
const ME = owner(1);
const wallets = new Set([ME.toLowerCase()]);

/** A queued transaction of `safe` submitted at `sec`. */
function queued(
  safe: LinkedSafeRow,
  nonce: number,
  sec: number,
  extra: Partial<MultisigTransaction> = {},
): MultisigTransaction {
  return executed(safe, nonce, null, {
    isExecuted: false,
    isSuccessful: null,
    executor: null,
    submissionDate: new Date(sec * 1000),
    confirmationsRequired: 2,
    confirmations: [],
    ...extra,
  });
}

const signedBy = (
  ...owners: Array<Address>
): MultisigTransaction['confirmations'] =>
  owners.map((o) => confirmationBuilder().with('owner', o).build());

function read(
  safe: LinkedSafeRow,
  txs: Array<MultisigTransaction>,
  next: string | null = null,
): QueueSafeRead {
  return {
    safe,
    ...queueSafeRows(safe, [ME, owner(2)], { results: txs, next }, wallets),
  };
}

function pageAll(
  reads: () => Array<QueueSafeRead>,
  limit: number,
  between?: (n: number) => void,
): Array<Array<string>> {
  const pages: Array<Array<string>> = [];
  let after: QueueKey | null = null;
  do {
    const p = queuePage(reads(), { limit, after });
    pages.push(p.items.map((r) => `${r.linkedSafeId}${r.nonce}`));
    after = p.nextKey;
    between?.(pages.length);
  } while (after !== null && pages.length < 50);
  return pages;
}

describe('queue rows', () => {
  const A = linked('A', '1', 1);

  it('raw fields, canonical id and status from raw data', () => {
    const waiting = queued(A, 5, T0, { confirmations: signedBy(owner(2)) });
    const ready = queued(A, 6, T0 - 1, {
      confirmations: signedBy(owner(2), owner(3)),
    });
    const { rows } = queueSafeRows(
      A,
      [ME],
      { results: [waiting, ready], next: null },
      wallets,
    );

    expect(rows[0]).toMatchObject({
      type: 'multisig',
      id: `multisig_${A.address}_${waiting.safeTxHash}`,
      linkedSafeId: 'A',
      chainId: '1',
      safeAddress: A.address,
      nonce: 5,
      timestamp: new Date(T0 * 1000).toISOString(),
      submittedAt: new Date(T0 * 1000).toISOString(),
      executedAt: null,
      confirmations: 1,
      threshold: 2,
      status: 'awaiting_confirmations',
      transaction: null,
    });
    expect(rows[1].status).toBe('awaiting_execution');
  });

  it('awaitingMe: my live owner wallet has not signed and the tx is below threshold', () => {
    const txs = [
      queued(A, 1, T0),
      queued(A, 2, T0, { confirmations: signedBy(ME) }),
      queued(A, 3, T0, { confirmations: signedBy(owner(2), owner(3)) }),
    ];
    const mine = queueSafeRows(
      A,
      [ME, owner(2)],
      { results: txs, next: null },
      wallets,
    );
    const notOwner = queueSafeRows(
      A,
      [owner(2)],
      { results: txs, next: null },
      wallets,
    );

    expect(mine.rows.map((r) => r.awaitingMe)).toEqual([true, false, false]);
    expect(notOwner.rows.map((r) => r.awaitingMe)).toEqual([
      false,
      false,
      false,
    ]);
  });

  it('conflict when another fetched queued tx of the Safe has the same nonce; truncated when the tx-service has more', () => {
    const r = queueSafeRows(
      A,
      [ME],
      {
        results: [queued(A, 7, T0), queued(A, 7, T0 - 1), queued(A, 8, T0 - 2)],
        next: 'more',
      },
      wallets,
    );

    expect(r.rows.map((x) => x.conflict)).toEqual([true, true, false]);
    expect(r.truncated).toBe(true);
  });

  it('history rows are never awaitingMe or in conflict, and executed failures read as failed', () => {
    const row = toRow(
      A,
      executed(A, 1, T0, { isSuccessful: false }),
      'history',
      {
        awaitingMe: true,
        conflict: true,
      },
    );
    expect(row).toMatchObject({
      awaitingMe: false,
      conflict: false,
      status: 'failed',
    });
  });
});

describe('queuePage', () => {
  const A = linked('A', '1', 1);
  const B = linked('B', '1', 2);
  const C = linked('C', '10', 1);

  it('merges newest submission first across Safes', () => {
    const reads = (): Array<QueueSafeRead> => [
      read(A, [queued(A, 3, T0), queued(A, 2, T0 - 10)]),
      read(B, [queued(B, 9, T0 - 5)]),
      read(C, [queued(C, 1, T0 - 1)]),
    ];

    expect(pageAll(reads, 10)).toEqual([['A3', 'C1', 'B9', 'A2']]);
  });

  it('identical (submittedAt, chainId, safeAddress) with different safeTxHash: ordered by hash, pages neither skip nor repeat', () => {
    const txs = [queued(A, 4, T0), queued(A, 5, T0), queued(A, 6, T0)];
    const byHash = [...txs].sort((x, y) =>
      x.safeTxHash < y.safeTxHash ? -1 : 1,
    );
    const pages = pageAll(() => [read(A, txs)], 1);

    expect(pages).toEqual(byHash.map((t) => [`A${t.nonce}`]));
  });

  it('insertion and deletion between pages: no skip, no repeat; new rows wait for a reset', () => {
    let a = [
      queued(A, 1, T0),
      queued(A, 2, T0 - 1),
      queued(A, 3, T0 - 2),
      queued(A, 4, T0 - 3),
    ];
    const pages = pageAll(
      () => [read(A, a)],
      2,
      (n) => {
        if (n === 1) {
          a = [queued(A, 9, T0 + 100), ...a.filter((t) => t.nonce !== 3)];
        }
      },
    );

    expect(pages).toEqual([['A1', 'A2'], ['A4']]);
  });

  it('kind and mine filter the items; counts ignore them', () => {
    const p = queuePage(
      [
        read(A, [
          queued(A, 1, T0),
          queued(A, 2, T0 - 1, {
            to: A.address,
            data: settingsData,
            value: '0',
            confirmations: signedBy(ME),
          }),
        ]),
      ],
      { limit: 10, after: null, kind: ['settings'], mine: false },
    );
    const mine = queuePage(
      [
        read(A, [
          queued(A, 1, T0),
          queued(A, 2, T0 - 1, { confirmations: signedBy(ME) }),
        ]),
      ],
      {
        limit: 10,
        after: null,
        mine: true,
      },
    );

    expect(p.items.map((r) => r.kind)).toEqual(['settings']);
    expect(p.counts).toEqual({ queued: 2, awaitingMe: 1, complete: true });
    expect(mine.items.map((r) => r.nonce)).toEqual([1]);
    expect(mine.counts.queued).toBe(2);
  });

  it('counts are incomplete with an unreadable or truncated Safe; only unreadable makes the list incomplete', () => {
    const p = queuePage(
      [
        read(A, [queued(A, 1, T0)], 'more'),
        { safe: B, failed: true },
        read(C, []),
      ],
      { limit: 10, after: null },
    );

    expect(p.truncatedSafeIds).toEqual(['A']);
    expect(p.unavailableSafeIds).toEqual(['B']);
    expect(p.complete).toBe(false);
    expect(p.counts).toEqual({ queued: 1, awaitingMe: 1, complete: false });

    const truncatedOnly = queuePage([read(A, [queued(A, 1, T0)], 'more')], {
      limit: 10,
      after: null,
    });
    expect(truncatedOnly.complete).toBe(true);
    expect(truncatedOnly.counts.complete).toBe(false);
  });

  it('dedupes by (linkedSafeId, id): the same Safe address on two chains keeps both rows', () => {
    const onMainnet = linked('M', '1', 7);
    const onBase = linked('X', '8453', 7);
    const tx = queued(onMainnet, 1, T0);
    const p = queuePage([read(onMainnet, [tx, tx]), read(onBase, [tx])], {
      limit: 10,
      after: null,
    });

    expect(p.items.map((r) => [r.linkedSafeId, r.id])).toEqual([
      ['M', `multisig_${onMainnet.address}_${tx.safeTxHash}`],
      ['X', `multisig_${onMainnet.address}_${tx.safeTxHash}`],
    ]);
    expect(
      dedupe([
        { linkedSafeId: 'M', id: 'x' },
        { linkedSafeId: 'M', id: 'x' },
      ]),
    ).toHaveLength(1);
  });
});
