import type { Address, Hex } from 'viem';
import type { MultisigTransaction } from '@/modules/safe/domain/entities/multisig-transaction.entity';
import type { Transaction } from '@/modules/transactions/routes/entities/transaction.entity';
import type { LinkedSafeRow } from '@/modules/org/safes/linked-safes.service';
import { txKind, type Kind } from '@/modules/org/safes/transactions/tx-kind';

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

/** Raw row; `transaction` stays null until the page is mapped. */
export function toRow(
  safe: LinkedSafeRow,
  tx: MultisigTransaction,
  tab: 'queue' | 'history',
  flags: { awaitingMe: boolean; conflict: boolean } = {
    awaitingMe: false,
    conflict: false,
  },
): MultisigRow {
  const submittedAt = tx.submissionDate.toISOString();
  const executedAt = tx.executionDate?.toISOString() ?? null;
  return {
    type: 'multisig',
    id: multisigId(tx),
    linkedSafeId: safe.id,
    chainId: safe.chainId,
    safeAddress: tx.safe,
    safeTxHash: tx.safeTxHash,
    nonce: tx.nonce,
    kind: txKind(tx, tx.safe),
    timestamp: tab === 'queue' ? submittedAt : (executedAt ?? submittedAt),
    confirmations: tx.confirmations?.length ?? 0,
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
