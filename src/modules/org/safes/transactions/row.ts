import type { Address, Hex } from 'viem';
import type { MultisigTransaction } from '@/modules/safe/domain/entities/multisig-transaction.entity';
import type { Transaction } from '@/modules/transactions/routes/entities/transaction.entity';
import type { LinkedSafeRow } from '@/modules/org/safes/linked-safes.service';
import { txKind, type Kind } from '@/modules/org/safes/transactions/tx-kind';
import { unpackMultiSend } from '@/modules/org/common/multisend';

export const MAX_ACTIONS = 50;

export type BatchAction = {
  to: Address;
  value: string;
  /** 0 = call, 1 = delegatecall */
  operation: 0 | 1;
  /** inner call data is non-empty */
  hasData: boolean;
  method: string | null;
};

export type MultisigRow = {
  type: 'multisig';
  /** multisig_<safe>_<safeTxHash>; identity is (linkedSafeId, id) */
  id: string;
  linkedSafeId: string;
  chainId: string;
  safeAddress: Address;
  safeTxHash: Hex;
  nonce: number;
  kind: Kind;
  /** queue: submittedAt; history: executedAt */
  timestamp: string;
  confirmations: number;
  /** raw `to` of the multisig transaction */
  to: Address;
  /** execution hash; null while queued */
  txHash: Hex | null;
  /** oldest first */
  signedBy: Array<{ owner: Address; submittedAt: string }>;
  /** queue: the Safe's current owners; history: null (unknown at execution time) */
  owners: Array<Address> | null;
  /** batch only: first 50 inner calls; filled by the mapping phase (null on raw rows) */
  actions: Array<BatchAction> | null;
  /** batch only: real count of inner calls */
  actionsTotal: number | null;
  threshold: number;
  proposer: Address | null;
  submittedAt: string;
  executedAt: string | null;
  executor: Address | null;
  status:
    | 'awaiting_confirmations'
    | 'awaiting_execution'
    | 'executed'
    | 'failed';
  awaitingMe: boolean;
  conflict: boolean;
  /** filled by the mapping phase; null in the spec §4 failure cases */
  transaction: Transaction | null;
};

/**
 * Overview and Transactions rule: one of `myOwners` (my wallets that are live
 * owners) has not confirmed, and the transaction is not executable yet.
 */
export function awaitsSignatureFrom(
  tx: Pick<MultisigTransaction, 'confirmations' | 'confirmationsRequired'>,
  myOwners: ReadonlyArray<Address>,
): boolean {
  if ((tx.confirmations?.length ?? 0) >= tx.confirmationsRequired) return false;
  const signed = new Set(
    (tx.confirmations ?? []).map((c) => c.owner.toLowerCase()),
  );
  return myOwners.some((o) => !signed.has(o.toLowerCase()));
}

function status(tx: MultisigTransaction): MultisigRow['status'] {
  if (tx.isExecuted) return tx.isSuccessful === false ? 'failed' : 'executed';
  return (tx.confirmations?.length ?? 0) >= tx.confirmationsRequired
    ? 'awaiting_execution'
    : 'awaiting_confirmations';
}

/** `multisig_<safe>_<safeTxHash>` */
export const multisigId = (tx: MultisigTransaction): string =>
  `multisig_${tx.safe}_${tx.safeTxHash}`;

/** Identity of a row: (linkedSafeId, id). */
export const rowKey = (linkedSafeId: string, id: string): string =>
  `${linkedSafeId} ${id}`;

/** Batch inner calls of an emitted row; `method` is filled later. */
export function withActions(
  row: MultisigRow,
  tx: MultisigTransaction,
): MultisigRow {
  if (row.kind !== 'batch') return row;
  const calls = unpackMultiSend(tx.data ?? '0x');
  return {
    ...row,
    actions:
      calls?.slice(0, MAX_ACTIONS).map((c) => ({
        to: c.to,
        value: c.value.toString(),
        operation: c.operation,
        hasData: c.data !== '0x',
        method: null,
      })) ?? null,
    actionsTotal: calls?.length ?? null,
  };
}

/** Raw row; `transaction` stays null until the page is mapped. */
export function toRow(
  safe: LinkedSafeRow,
  tx: MultisigTransaction,
  tab: 'queue' | 'history',
  flags: { awaitingMe: boolean; conflict: boolean } = {
    awaitingMe: false,
    conflict: false,
  },
  owners: ReadonlyArray<Address> | null = null,
): MultisigRow {
  const submittedAt = tx.submissionDate.toISOString();
  const executedAt = tx.executionDate?.toISOString() ?? null;
  const kind = txKind(tx, tx.safe);
  return {
    type: 'multisig',
    id: multisigId(tx),
    linkedSafeId: safe.id,
    chainId: safe.chainId,
    safeAddress: tx.safe,
    safeTxHash: tx.safeTxHash,
    nonce: tx.nonce,
    kind,
    timestamp: tab === 'queue' ? submittedAt : (executedAt ?? submittedAt),
    confirmations: tx.confirmations?.length ?? 0,
    to: tx.to,
    txHash: tx.transactionHash,
    signedBy: [...(tx.confirmations ?? [])]
      .sort((a, b) => a.submissionDate.getTime() - b.submissionDate.getTime())
      .map((c) => ({
        owner: c.owner,
        submittedAt: c.submissionDate.toISOString(),
      })),
    owners: tab === 'queue' && owners ? [...owners] : null,
    actions: null,
    actionsTotal: null,
    threshold: tx.confirmationsRequired,
    proposer: tx.proposer,
    submittedAt,
    executedAt,
    executor: tx.executor,
    status: status(tx),
    awaitingMe: tab === 'queue' && flags.awaitingMe,
    conflict: tab === 'queue' && flags.conflict,
    transaction: null,
  };
}

/** Numeric chain order (10 < 100 < 8453), then lowercase address. */
export function compareSafe(
  a: { chainId: string; address: string },
  b: { chainId: string; address: string },
): number {
  const ca = BigInt(a.chainId);
  const cb = BigInt(b.chainId);
  if (ca !== cb) return ca < cb ? -1 : 1;
  return compareText(a.address.toLowerCase(), b.address.toLowerCase());
}

/** Code-unit order, as for lowercase hex. */
export function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Keeps the first row of each (linkedSafeId, id). */
export function dedupe<R extends Pick<MultisigRow, 'linkedSafeId' | 'id'>>(
  rows: ReadonlyArray<R>,
): Array<R> {
  const seen = new Set<string>();
  return rows.filter((r) => {
    const key = rowKey(r.linkedSafeId, r.id);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
