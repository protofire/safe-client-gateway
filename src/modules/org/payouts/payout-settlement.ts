import { decodeFunctionData, parseAbi, type Address, type Hex } from 'viem';
import { Operation } from '@/modules/safe/domain/entities/operation.entity';
import type { MultisigTransaction } from '@/modules/safe/domain/entities/multisig-transaction.entity';
import type { Transfer } from '@/modules/safe/domain/entities/transfer.entity';
import { walkCalls, type SafeCall } from '@/modules/org/common/multisend';
import {
  callsMismatch,
  reorgMarginMs,
  toRaw,
} from '@/modules/org/payouts/payout-verify';
import type { PayoutReview } from '@/modules/org/payouts/payout.schemas';

export type Settlement = {
  status:
    | 'executed'
    | 'failed'
    | 'replaced'
    | 'rejected'
    | 'needs_review'
    | 'verifying'
    | 'pending';
  executedTxHash?: Hex;
  review?: PayoutReview;
};

export type SettlementItem = {
  line: number;
  recipient: Address;
  token: Address | 'native';
  amountRaw: bigint;
};

export type SettlementInput = {
  run: {
    chainId: string;
    safeAddress: Address;
    /** null: a pinned draft edited after a release and not rebuilt */
    calls: ReadonlyArray<SafeCall> | null;
    items: ReadonlyArray<SettlementItem>;
  };
  /** Calls of earlier attempts at the same nonce (the run may have been edited since). */
  attemptCalls: ReadonlyArray<ReadonlyArray<SafeCall>>;
  /** The tx the tx-service lists as executed at the pinned nonce, if any. */
  executedAtNonce: MultisigTransaction | null;
  /** Whatever was read so far; a failed read = []. Records of another transactionHash are dropped here. */
  transfers: ReadonlyArray<Transfer>;
  /** Lowercase MultiSend + MultiSendCallOnly addresses unpacked when decoding. */
  trusted: ReadonlySet<string>;
  /** Lowercase MultiSendCallOnly addresses (`multiSendCallOnlySet`). */
  callOnly: ReadonlySet<string>;
  now: Date;
  /** verifying_since + 24 h; null until the run first enters `verifying`. */
  deadline: Date | null;
};

const transferAbi = parseAbi([
  'function transfer(address to, uint256 amount)',
  'function transferFrom(address from, address to, uint256 amount)',
]);

/** Receiver of an ERC20 transfer call, lowercase; null for anything else. */
function transferRecipient(data: Hex): string | null {
  try {
    const { functionName, args } = decodeFunctionData({
      abi: transferAbi,
      data,
    });
    return (functionName === 'transfer' ? args[0] : args[1]).toLowerCase();
  } catch {
    return null;
  }
}

const lower = (a: string): string => a.toLowerCase();

/** Who a call pays directly, lowercase: native value to `to`, an ERC20 transfer to its receiver. */
function payees(call: Pick<SafeCall, 'to' | 'value' | 'data'>): Array<string> {
  const token = transferRecipient(call.data);
  return [
    ...(call.value > 0n ? [lower(call.to)] : []),
    ...(token === null ? [] : [token]),
  ];
}

/** Lines of ERC20 items without their own transfer (multiset: duplicates need one each). */
function missingTransferLines(
  items: ReadonlyArray<SettlementItem>,
  transfers: ReadonlyArray<Transfer>,
  safe: Address,
): Array<number> {
  const unused = transfers.filter(
    (t) => t.type === 'ERC20_TRANSFER' && lower(t.from) === lower(safe),
  );
  const missing: Array<number> = [];
  for (const item of items) {
    if (item.token === 'native') continue; // proven by isSuccessful: a failed native call reverts MultiSendCallOnly
    const at = unused.findIndex(
      (t) =>
        t.type === 'ERC20_TRANSFER' &&
        lower(t.tokenAddress) === lower(item.token) &&
        lower(t.to) === lower(item.recipient) &&
        toRaw(t.value) === item.amountRaw,
    );
    if (at === -1) missing.push(item.line);
    else unused.splice(at, 1);
  }
  return missing.sort((a, b) => a - b);
}

/**
 * Outcome of the run once its pinned nonce N is used, from the tx executed
 * at N (after the reorg margin): rejection → rejected, reverted → failed,
 * the run's calls → executed (every ERC20 item needs its transfer; at the
 * deadline missing ones → needs_review missing_transfers), an earlier
 * attempt's calls or a decoded direct payment to a run recipient →
 * needs_review partial_overlap, anything else → replaced.
 */
export function settlementOutcome(input: SettlementInput): Settlement {
  const { run, now, deadline } = input;
  const tx = input.executedAtNonce;
  if (tx === null || !tx.isExecuted || tx.isSuccessful === null)
    return { status: 'pending' };
  const value = toRaw(tx.value);
  if (value === null) return { status: 'pending' };

  const txHash = tx.transactionHash;
  const settle = (
    status: Settlement['status'],
    review?: PayoutReview,
  ): Settlement => ({
    status,
    ...(txHash !== null && { executedTxHash: txHash }),
    ...(review && { review }),
  });

  if (
    tx.executionDate === null ||
    now.getTime() - tx.executionDate.getTime() < reorgMarginMs(run.chainId)
  )
    return settle('verifying');

  const data = tx.data ?? '0x';
  if (
    lower(tx.to) === lower(run.safeAddress) &&
    value === 0n &&
    data === '0x' &&
    tx.operation === Operation.CALL
  )
    return settle('rejected');
  if (tx.isSuccessful === false) return settle('failed');

  if (
    run.calls !== null &&
    callsMismatch(tx, run.calls, input.callOnly) === null
  ) {
    // the tx-service filter is not trusted: only records of this execution count, each once
    const seen = new Set<string>();
    const transfers = input.transfers.filter((t) => {
      if (txHash === null || lower(t.transactionHash) !== lower(txHash))
        return false;
      if (seen.has(t.transferId)) return false;
      seen.add(t.transferId);
      return true;
    });
    const lines = missingTransferLines(run.items, transfers, run.safeAddress);
    if (lines.length === 0) return settle('executed');
    return deadline !== null && now.getTime() >= deadline.getTime()
      ? settle('needs_review', { reason: 'missing_transfers', lines })
      : settle('verifying');
  }

  const earlierAttempt = input.attemptCalls.some(
    (calls) => callsMismatch(tx, calls, input.callOnly) === null,
  );
  // recipients of the items and of every earlier attempt at N (the run may have been edited since)
  const recipients = new Set([
    ...run.items.map((i) => lower(i.recipient)),
    ...input.attemptCalls.flat().flatMap(payees),
  ]);
  // whatever part of the tx decodes; indirect payments (contracts, guards, modules) are an accepted residual risk
  const paysRecipient = walkCalls(
    { to: tx.to, value, data, operation: tx.operation },
    input.trusted,
  ).calls.some((call) => payees(call).some((to) => recipients.has(to)));
  if (earlierAttempt || paysRecipient)
    return settle('needs_review', { reason: 'partial_overlap' });
  return settle('replaced');
}
