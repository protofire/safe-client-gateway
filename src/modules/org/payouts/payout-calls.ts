import { encodeFunctionData, erc20Abi, size } from 'viem';
import type { Address } from 'viem';
import type { SafeCall } from '@/modules/org/common/multisend';

export type PayoutCallInput = {
  recipient: Address;
  token: Address | 'native';
  amountRaw: bigint;
};

// Worst case per call: cold recipient account / new token holder (B5 Step 6 checks them on Base Sepolia)
export const TX_OVERHEAD_GAS = 60_000n;
export const NATIVE_CALL_GAS = 45_000n;
export const ERC20_CALL_GAS = 70_000n;
/** Calldata gas per packed MultiSend byte (non-zero byte price, an upper bound). */
export const CALLDATA_BYTE_GAS = 16n;
/** operation (1) + to (20) + value (32) + data length (32) */
const PACKED_ENTRY_BYTES = 85n;
// shortcut: fixed upper-bound estimates, not eth_estimateGas; make per-chain if a chain's block gas limit is < 15M
export const PAYOUT_GAS_BOUND = 6_000_000n;

/** One payout item as the inner call of the run's Safe transaction. */
export function toCall(item: PayoutCallInput): SafeCall {
  if (item.token === 'native') {
    return {
      to: item.recipient,
      value: item.amountRaw,
      data: '0x',
      operation: 0,
    };
  }
  return {
    to: item.token,
    value: 0n,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: 'transfer',
      args: [item.recipient, item.amountRaw],
    }),
    operation: 0,
  };
}

function callGas(call: SafeCall): bigint {
  const base = call.data === '0x' ? NATIVE_CALL_GAS : ERC20_CALL_GAS;
  return (
    base + CALLDATA_BYTE_GAS * (PACKED_ENTRY_BYTES + BigInt(size(call.data)))
  );
}

/** Upper-bound gas of one Safe transaction carrying `calls` (no RPC). */
export function estimateRunGas(calls: ReadonlyArray<SafeCall>): bigint {
  return calls.reduce((sum, call) => sum + callGas(call), TX_OVERHEAD_GAS);
}

/**
 * One run = one Safe transaction: `ok` iff the estimate is within `bound`;
 * otherwise `maxRecipients` is how many leading calls (input order) fit.
 */
export function checkRunSize(
  calls: ReadonlyArray<SafeCall>,
  bound: bigint = PAYOUT_GAS_BOUND,
):
  | { ok: true; estimatedGas: bigint }
  | { ok: false; estimatedGas: bigint; maxRecipients: number } {
  let estimatedGas = TX_OVERHEAD_GAS;
  let maxRecipients = 0;
  for (const call of calls) {
    estimatedGas += callGas(call);
    if (estimatedGas <= bound) maxRecipients++;
  }
  return estimatedGas <= bound
    ? { ok: true, estimatedGas }
    : { ok: false, estimatedGas, maxRecipients };
}
