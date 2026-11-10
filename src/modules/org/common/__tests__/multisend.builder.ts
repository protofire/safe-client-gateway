import {
  encodeFunctionData,
  encodePacked,
  parseAbi,
  size,
  type Hex,
} from 'viem';
import type { SafeCall } from '@/modules/org/common/multisend';

const multiSendAbi = parseAbi(['function multiSend(bytes transactions)']);

/** Packed `transactions` bytes as MultiSend expects them. */
export function packCalls(calls: ReadonlyArray<SafeCall>): Hex {
  return encodePacked(
    calls.flatMap(() => ['uint8', 'address', 'uint256', 'uint256', 'bytes']),
    calls.flatMap((c) => [
      c.operation,
      c.to,
      c.value,
      BigInt(size(c.data)),
      c.data,
    ]),
  );
}

export function multiSendData(packed: Hex): Hex {
  return encodeFunctionData({
    abi: multiSendAbi,
    functionName: 'multiSend',
    args: [packed],
  });
}

/** A delegatecall to `multiSend` at `to` wrapping `calls`. */
export function multiSendCall(
  to: SafeCall['to'],
  calls: ReadonlyArray<SafeCall>,
): SafeCall {
  return { to, value: 0n, data: multiSendData(packCalls(calls)), operation: 1 };
}
