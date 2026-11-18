import { getAddress, numberToHex, type Address, type Hex } from 'viem';
import type { Confirmation } from '@/modules/safe/domain/entities/multisig-transaction.entity';
import { confirmationBuilder } from '@/modules/safe/domain/entities/__tests__/multisig-transaction-confirmation.builder';
import {
  multiSendData,
  packCalls,
} from '@/modules/org/common/__tests__/multisend.builder';
import {
  T0,
  executed,
  linked,
} from '@/modules/org/safes/transactions/__tests__/model';
import {
  MAX_ACTIONS,
  toRow,
  withActions,
} from '@/modules/org/safes/transactions/row';

const A = linked('A', '1', 1);
const addr = (n: number): Address =>
  getAddress(numberToHex(0x2000 + n, { size: 20 }));

const batch = (n: number): Hex =>
  multiSendData(
    packCalls(
      Array.from({ length: n }, (_, i) => ({
        to: addr(i),
        value: BigInt(i),
        data: '0x' as Hex,
        operation: 0 as const,
      })),
    ),
  );

const confirm = (owner: Address, sec: number): Confirmation =>
  confirmationBuilder()
    .with('owner', owner)
    .with('submissionDate', new Date(sec * 1000))
    .build();

describe('toRow raw fields', () => {
  it('lists signers oldest first, and an empty array when none', () => {
    const tx = executed(A, 1, null, {
      confirmations: [confirm(addr(2), T0 + 20), confirm(addr(1), T0 + 10)],
    });
    expect(toRow(A, tx, 'queue').signedBy).toEqual([
      { owner: addr(1), submittedAt: new Date((T0 + 10) * 1000).toISOString() },
      { owner: addr(2), submittedAt: new Date((T0 + 20) * 1000).toISOString() },
    ]);
    expect(toRow(A, executed(A, 2, null), 'queue').signedBy).toEqual([]);
  });

  it('carries the owners on the queue and null on history', () => {
    const tx = executed(A, 1, T0);
    const flags = { awaitingMe: false, conflict: false };
    expect(toRow(A, tx, 'queue', flags, [addr(1)]).owners).toEqual([addr(1)]);
    expect(toRow(A, tx, 'history', flags, [addr(1)]).owners).toBeNull();
  });

  it('carries recipient, value and execution hash', () => {
    const hash = numberToHex(7, { size: 32 });
    const row = toRow(
      A,
      executed(A, 1, T0, { transactionHash: hash }),
      'history',
    );
    expect(row.txHash).toBe(hash);
    expect(row).not.toHaveProperty('value');
    expect(row.to).toBe(executed(A, 1, T0).to);
    expect(
      toRow(A, executed(A, 2, null, { transactionHash: null }), 'queue').txHash,
    ).toBeNull();
  });

  it('lists the inner calls of a batch with a null method', () => {
    const tx = executed(A, 1, T0, { data: batch(3) });
    const row = withActions(toRow(A, tx, 'history'), tx);
    expect(row.kind).toBe('batch');
    expect(row.actionsTotal).toBe(3);
    expect(row.actions).toEqual([
      { to: addr(0), value: '0', operation: 0, hasData: false, method: null },
      { to: addr(1), value: '1', operation: 0, hasData: false, method: null },
      { to: addr(2), value: '2', operation: 0, hasData: false, method: null },
    ]);
  });

  it('caps batch actions at 50 and keeps the real count', () => {
    const tx = executed(A, 1, T0, { data: batch(60) });
    const row = withActions(toRow(A, tx, 'history'), tx);
    expect(row.actions).toHaveLength(MAX_ACTIONS);
    expect(row.actionsTotal).toBe(60);
  });

  it('has null actions for a non-batch row, and every new field with transaction null', () => {
    const row = toRow(A, executed(A, 1, T0), 'history');
    expect(row).toMatchObject({
      actions: null,
      actionsTotal: null,
      transaction: null,
    });
    expect(row.to).toBeDefined();
    expect(row.signedBy).toEqual([]);
  });

  it('flags delegatecalls and non-empty inner data', () => {
    const data = multiSendData(
      packCalls([
        { to: addr(0), value: 0n, data: '0xdeadbeef' as Hex, operation: 1 },
      ]),
    );
    const tx = executed(A, 1, T0, { data });
    expect(withActions(toRow(A, tx, 'history'), tx).actions).toEqual([
      { to: addr(0), value: '0', operation: 1, hasData: true, method: null },
    ]);
  });

  it('toRow leaves actions to the mapping phase', () => {
    const row = toRow(A, executed(A, 1, T0, { data: batch(2) }), 'history');
    expect(row).toMatchObject({ actions: null, actionsTotal: null });
  });
});
