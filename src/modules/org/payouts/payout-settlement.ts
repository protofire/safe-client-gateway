import { decodeFunctionData, parseAbi, type Address, type Hex } from 'viem';
import { Operation } from '@/modules/safe/domain/entities/operation.entity';
import type { MultisigTransaction } from '@/modules/safe/domain/entities/multisig-transaction.entity';
import type { Transfer } from '@/modules/safe/domain/entities/transfer.entity';
import { flattenCalls, type SafeCall } from '@/modules/org/common/multisend';
import {
  callsEqual,
  callsMismatch,
  isZeroAddress,
  reorgMarginMs,
  toRaw,
} from '@/modules/org/payouts/payout-verify';

export type ReviewReason =
  | 'missing_transfers'
  | 'partial_overlap'
  | 'undecodable'
  | 'indirect_unproven';

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
  review?: { reason: ReviewReason; lines?: Array<number> };
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
  /** Lowercase MultiSend + MultiSendCallOnly addresses unpacked when flattening. */
  trusted: ReadonlySet<string>;
  /** Lowercase MultiSendCallOnly addresses (`multiSendCallOnlySet`). */
  callOnly: ReadonlySet<string>;
  now: Date;
  /** verifying_since + 24 h; null until the run first enters `verifying`. */
  deadline: Date | null;
};

const paymentAbi = parseAbi([
  'function transfer(address to, uint256 amount)',
  'function transferFrom(address from, address to, uint256 amount)',
  'function approve(address spender, uint256 amount)',
  'function increaseAllowance(address spender, uint256 amount)',
]);

/** ERC20 payment (or allowance) a call makes: `token` = call target, `recipient` = receiver or spender. */
function decodePayment(call: Pick<SafeCall, 'to' | 'data'>): {
  token: string;
  recipient: string;
  amount: bigint;
  allowance: boolean;
} | null {
  try {
    const { functionName, args } = decodeFunctionData({
      abi: paymentAbi,
      data: call.data,
    });
    const [recipient, amount] =
      functionName === 'transferFrom' ? [args[1], args[2]] : [args[0], args[1]];
    return {
      token: call.to.toLowerCase(),
      recipient: recipient.toLowerCase(),
      amount,
      allowance:
        functionName === 'approve' || functionName === 'increaseAllowance',
    };
  } catch {
    return null;
  }
}

const lower = (a: string): string => a.toLowerCase();
const pairKey = (token: string, recipient: string): string =>
  `${lower(token)}:${lower(recipient)}`;

/** Everything the run (now or in an earlier attempt at N) pays or would pay. */
function runTargets(input: SettlementInput): {
  calls: Array<SafeCall>;
  erc20: Set<string>;
  native: Set<string>;
} {
  const calls = [...(input.run.calls ?? []), ...input.attemptCalls.flat()];
  const erc20 = new Set<string>();
  const native = new Set<string>();
  for (const item of input.run.items) {
    if (item.token === 'native') native.add(lower(item.recipient));
    else erc20.add(pairKey(item.token, item.recipient));
  }
  for (const call of calls) {
    if (call.value > 0n) native.add(lower(call.to));
    const payment = decodePayment(call);
    if (payment) erc20.add(pairKey(payment.token, payment.recipient));
  }
  return { calls, erc20, native };
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
 * Outcome of the run once its pinned nonce N is consumed. Positive conclusions
 * any time after the reorg margin; negative ones only at `now >= deadline`.
 * When in doubt → `needs_review` or `verifying`, never `replaced`.
 */
export function settlementOutcome(input: SettlementInput): Settlement {
  const { run, now, deadline } = input;
  const tx = input.executedAtNonce;
  if (tx === null || !tx.isExecuted || tx.isSuccessful === null)
    return { status: 'pending' };
  const value = toRaw(tx.value);
  const gasPrice = tx.gasPrice === null ? 0n : toRaw(tx.gasPrice);
  // unreadable tx-service numbers: no decision
  if (value === null || gasPrice === null) return { status: 'pending' };

  const txHash = tx.transactionHash;
  const settle = (
    status: Settlement['status'],
    review?: Settlement['review'],
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
  const atDeadline = deadline !== null && now.getTime() >= deadline.getTime();
  const unproven = (): Settlement =>
    atDeadline
      ? settle('needs_review', { reason: 'indirect_unproven' })
      : settle('verifying');
  // the tx-service filter is not trusted: only records of this execution count, each once
  const seen = new Set<string>();
  const transfers = input.transfers.filter((t) => {
    if (txHash === null || lower(t.transactionHash) !== lower(txHash))
      return false;
    if (seen.has(t.transferId)) return false;
    seen.add(t.transferId);
    return true;
  });
  const data = tx.data ?? '0x';
  const safe = run.safeAddress;
  const targets = runTargets(input);

  // gasPrice > 0: the Safe refunds gas (gasToken or native) to refundReceiver, or to the executor if zero
  const refund = gasPrice > 0n;
  if (refund) {
    const receiver = isZeroAddress(tx.refundReceiver)
      ? tx.executor
      : tx.refundReceiver;
    const paid =
      receiver !== null &&
      (isZeroAddress(tx.gasToken) || tx.gasToken === null
        ? targets.native.has(lower(receiver))
        : targets.erc20.has(pairKey(tx.gasToken, receiver)));
    if (paid) return settle('needs_review', { reason: 'partial_overlap' });
  }

  if (
    lower(tx.to) === lower(safe) &&
    value === 0n &&
    data === '0x' &&
    tx.operation === Operation.CALL
  )
    return refund ? unproven() : settle('rejected');

  if (
    run.calls !== null &&
    lower(tx.safe) === lower(safe) &&
    callsMismatch(tx, run.calls, input.callOnly) === null
  ) {
    if (tx.isSuccessful === false)
      return refund ? unproven() : settle('failed');
    const lines = missingTransferLines(run.items, transfers, safe);
    if (lines.length === 0) return settle('executed');
    return atDeadline
      ? settle('needs_review', { reason: 'missing_transfers', lines })
      : settle('verifying');
  }

  // a reverted tx without a refund moved nothing
  if (tx.isSuccessful === false)
    return refund ? unproven() : settle('replaced');

  const flat = flattenCalls(
    { to: tx.to, value, data, operation: tx.operation },
    input.trusted,
  );
  // zero calls (`multiSend(0x)`) cannot be matched to anything: undecodable
  if (!flat.ok || flat.calls.length === 0)
    return settle('needs_review', { reason: 'undecodable' });

  const callOverlaps = flat.calls.some((call) => {
    if (targets.calls.some((known) => callsEqual(call, known))) return true;
    if (call.value > 0n && targets.native.has(lower(call.to))) return true;
    const payment = decodePayment(call);
    // an allowance > 0 to a run recipient enables a later pull; approve(x, 0) is a revocation
    return (
      payment !== null &&
      (!payment.allowance || payment.amount > 0n) &&
      targets.erc20.has(pairKey(payment.token, payment.recipient))
    );
  });
  const transferOverlaps = transfers.some(
    (t) =>
      lower(t.from) === lower(safe) &&
      ((t.type === 'ERC20_TRANSFER' &&
        targets.erc20.has(pairKey(t.tokenAddress, t.to))) ||
        (t.type === 'ETHER_TRANSFER' && targets.native.has(lower(t.to)))),
  );
  if (callOverlaps || transferOverlaps)
    return settle('needs_review', { reason: 'partial_overlap' });

  // shortcut: a native recipient or an ERC20 "token" may be a contract that pays on (receive hook, non-standard token); the decoded shape is trusted, add trace inspection if that matters
  const plain = flat.calls.every(
    (c) => c.data === '0x' || (c.value === 0n && decodePayment(c) !== null),
  );
  return plain && !refund ? settle('replaced') : unproven();
}
