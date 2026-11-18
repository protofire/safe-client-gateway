import { encodeFunctionData, getAddress, numberToHex, parseAbi } from 'viem';
import type { Hex } from 'viem';
import { multisigTransactionBuilder } from '@/modules/safe/domain/entities/__tests__/multisig-transaction.builder';
import type { MultisigTransaction } from '@/modules/safe/domain/entities/multisig-transaction.entity';
import type { LinkedSafeRow } from '@/modules/org/safes/linked-safes.service';
import type {
  HistoryQuery,
  HistoryReader,
} from '@/modules/org/safes/transactions/history-merge';

export const T0 = Date.UTC(2026, 0, 1) / 1000;
let hashSeq = 0;

export function linked(id: string, chainId: string, n: number): LinkedSafeRow {
  return {
    id,
    chainId,
    address: getAddress(numberToHex(n, { size: 20 })),
    label: null,
  };
}

const RECIPIENT = getAddress(numberToHex(0xbeef, { size: 20 }));

/** An executed transaction of `safe`: a native transfer unless overridden. */
export function executed(
  safe: LinkedSafeRow,
  nonce: number,
  sec: number | null,
  extra: Partial<MultisigTransaction> = {},
): MultisigTransaction {
  const tx = multisigTransactionBuilder()
    .with('safe', safe.address)
    .with('nonce', nonce)
    .with('isExecuted', true)
    .with('isSuccessful', true)
    .with('executionDate', sec === null ? null : new Date(sec * 1000))
    .with('submissionDate', new Date((sec ?? T0) * 1000 - 60_000))
    .with('to', RECIPIENT)
    .with('value', '1')
    .with('data', null)
    .with('operation', 0)
    .with('safeTxHash', numberToHex(++hashSeq, { size: 32 }))
    .with('confirmationsRequired', 1)
    .with('confirmations', [])
    .build();
  return { ...tx, ...extra };
}

export const settingsData: Hex = encodeFunctionData({
  abi: parseAbi(['function changeThreshold(uint256)']),
  functionName: 'changeThreshold',
  args: [2n],
});

/** In-memory tx-service multisig list: executionDateLte, nonceLt, -nonce, limit, offset. */
export function txService(db: Map<string, Array<MultisigTransaction>>): {
  read: HistoryReader;
  calls: Array<{ safeId: string } & HistoryQuery>;
  failWhen?: (safeId: string, q: HistoryQuery) => boolean;
} {
  const model = {
    calls: [] as Array<{ safeId: string } & HistoryQuery>,
    failWhen: undefined as
      | undefined
      | ((safeId: string, q: HistoryQuery) => boolean),
    read: ((safe, q) => {
      model.calls.push({ safeId: safe.id, ...q });
      if (model.failWhen?.(safe.id, q)) {
        return Promise.reject(new Error('tx-service down'));
      }
      const lte =
        q.executionDateLte === undefined
          ? null
          : Date.parse(q.executionDateLte);
      const rows = (db.get(safe.id) ?? [])
        .filter((tx) => tx.isExecuted)
        .filter(
          (tx) =>
            lte === null ||
            (tx.executionDate !== null && tx.executionDate.getTime() <= lte),
        )
        .filter((tx) => q.nonceLt === undefined || tx.nonce < q.nonceLt)
        .sort((a, b) => b.nonce - a.nonce);
      return Promise.resolve({
        results: rows.slice(q.offset, q.offset + q.limit),
        next: q.offset + q.limit < rows.length ? 'next' : null,
      });
    }) as HistoryReader,
  };
  return model;
}
