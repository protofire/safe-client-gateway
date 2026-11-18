import { _SAFE_DEPLOYMENTS } from '@safe-global/safe-deployments/dist/deployments';
import { zeroAddress, type Address, type Hex } from 'viem';
import { getMultiSendCallOnlyDeployments } from '@/domain/common/utils/deployments';
import { Operation } from '@/modules/safe/domain/entities/operation.entity';
import type { MultisigTransaction } from '@/modules/safe/domain/entities/multisig-transaction.entity';
import { unpackMultiSend, type SafeCall } from '@/modules/org/common/multisend';

export type VerifyResult =
  | { ok: true }
  | { ok: false; code: 'tx_mismatch'; field: string };

/** Lowercase MultiSendCallOnly addresses of every Safe version on the chain; the chain config's only where safe-deployments has none. Plain MultiSend is not in it. */
export function multiSendCallOnlySet(
  chainId: string,
  chainConfigAddress?: Address,
): ReadonlySet<string> {
  const set = new Set(
    _SAFE_DEPLOYMENTS
      .flatMap(({ version }) =>
        getMultiSendCallOnlyDeployments({ chainId, version }),
      )
      .map((a) => a.toLowerCase()),
  );
  // a wrong config entry must not widen a chain the deployments already cover
  if (set.size === 0 && chainConfigAddress)
    set.add(chainConfigAddress.toLowerCase());
  return set;
}

const MINUTE = 60_000;
// C1 inventory: Ethereum-PoS finality (~13 min) and weak-finality chains wait longer
const REORG_MARGIN_MIN: Record<string, number> = {
  '1': 15,
  '11155111': 15,
  '560048': 15,
  '167000': 15,
  '167013': 15,
  '30': 30,
  '31': 30,
  '314': 30,
  '314159': 30,
  '137': 30,
};

/** Wall-clock age an execution must reach before settlement trusts it. */
export function reorgMarginMs(chainId: string): number {
  return (REORG_MARGIN_MIN[chainId] ?? 5) * MINUTE;
}

/** A tx-service integer string as bigint; null if it is not a plain non-negative integer. */
export const toRaw = (s: string): bigint | null =>
  /^\d+$/.test(s) ? BigInt(s) : null;

const normData = (data: Hex | null): string => (data ?? '0x').toLowerCase();
const sameAddress = (a: string | null, b: string): boolean =>
  a !== null && a.toLowerCase() === b.toLowerCase();
export const isZeroAddress = (a: string | null): boolean =>
  a === null || sameAddress(a, zeroAddress);

function firstDifference(
  actual: Pick<SafeCall, 'to' | 'value'> & { data: Hex | null },
  expected: SafeCall,
): 'to' | 'value' | 'data' | null {
  if (!sameAddress(actual.to, expected.to)) return 'to';
  if (actual.value !== expected.value) return 'value';
  if (normData(actual.data) !== normData(expected.data)) return 'data';
  return null;
}

/**
 * Whether the tx's calls are exactly `calls`: one call → a direct call;
 * ≥ 2 → a delegatecall to MultiSendCallOnly (value 0) whose unpacked calls
 * are all plain calls equal per index. Returns the first differing field.
 */
export function callsMismatch(
  tx: Pick<MultisigTransaction, 'to' | 'value' | 'data' | 'operation'>,
  calls: ReadonlyArray<SafeCall>,
  callOnly: ReadonlySet<string>,
): Exclude<VerifyResult, { ok: true }> | null {
  const mismatch = (field: string): Exclude<VerifyResult, { ok: true }> => ({
    ok: false,
    code: 'tx_mismatch',
    field,
  });
  const value = toRaw(tx.value);
  if (value === null) return mismatch('value');
  if (calls.length === 1) {
    if (tx.operation !== Operation.CALL) return mismatch('operation');
    const diff = firstDifference({ to: tx.to, value, data: tx.data }, calls[0]);
    return diff === null ? null : mismatch(diff);
  }
  if (calls.length === 0) return mismatch('calls');
  if (!callOnly.has(tx.to.toLowerCase())) return mismatch('multisend');
  if (tx.operation !== Operation.DELEGATE) return mismatch('operation');
  if (value !== 0n) return mismatch('value');
  const inner = tx.data === null ? null : unpackMultiSend(tx.data);
  if (inner === null) return mismatch('data');
  if (inner.length !== calls.length) return mismatch('calls');
  const delegate = inner.findIndex((c) => c.operation !== 0);
  if (delegate !== -1) return mismatch(`calls.${delegate}.operation`);
  for (let i = 0; i < calls.length; i++) {
    const diff = firstDifference(inner[i], calls[i]);
    if (diff !== null) return mismatch(`calls.${i}.${diff}`);
  }
  return null;
}

/** Strict check of a reported Safe tx against the run (execution state ignored). */
export function verifyProposedTx(
  tx: MultisigTransaction,
  run: { safeAddress: Address; nonce: bigint; calls: ReadonlyArray<SafeCall> },
  callOnly: ReadonlySet<string>,
): VerifyResult {
  const mismatch = (field: string): VerifyResult => ({
    ok: false,
    code: 'tx_mismatch',
    field,
  });
  if (!sameAddress(tx.safe, run.safeAddress)) return mismatch('safe');
  if (!Number.isSafeInteger(tx.nonce) || BigInt(tx.nonce) !== run.nonce)
    return mismatch('nonce');
  if (tx.gasPrice !== null && toRaw(tx.gasPrice) !== 0n)
    return mismatch('gasPrice');
  if (!isZeroAddress(tx.gasToken)) return mismatch('gasToken');
  if (!isZeroAddress(tx.refundReceiver)) return mismatch('refundReceiver');
  // shortcut: any safeTxGas is accepted (Safes < 1.3.0 require one, the signing flow may set an estimate); a too-low value can only make the tx fail (`failed`, nothing paid), accepted griefing
  return callsMismatch(tx, run.calls, callOnly) ?? { ok: true };
}
