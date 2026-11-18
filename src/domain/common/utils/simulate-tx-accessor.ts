import {
  decodeAbiParameters,
  encodeFunctionData,
  hexToBigInt,
  isHex,
  parseAbi,
  size,
  slice,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { getSimulateTxAccessorDeployments } from '@/domain/common/utils/deployments';

/** SimulateTxAccessor versions to look for, newest first; any of them works with a Safe ≥ 1.3.0 */
const ACCESSOR_VERSIONS = ['1.4.1', '1.3.0'];
const SAFE_ABI = parseAbi([
  'function simulateAndRevert(address targetContract, bytes calldataPayload)',
]);
const ACCESSOR_ABI = parseAbi([
  'function simulate(address to, uint256 value, bytes data, uint8 operation) returns (uint256 estimate, bool success, bytes returnData)',
]);

export type TxSimulation = {
  estimate: bigint;
  success: boolean;
  returnData: Hex;
};

/** The chain's SimulateTxAccessor, if safe-deployments knows one. */
export function getSimulateTxAccessor(chainId: string): Address | undefined {
  return ACCESSOR_VERSIONS.flatMap((version) =>
    getSimulateTxAccessorDeployments({ chainId, version }),
  )[0];
}

/**
 * `eth_call` at latest of the Safe's `simulateAndRevert(accessor, simulate(call))`.
 * Null when there is no simulation result: RPC error or timeout, or a Safe without `simulateAndRevert`.
 */
export async function simulateSafeCall(
  client: Pick<PublicClient, 'request'>,
  args: {
    safeAddress: Address;
    accessor: Address;
    to: Address;
    value: bigint;
    data: Hex;
    operation: number;
  },
): Promise<TxSimulation | null> {
  const payload = encodeFunctionData({
    abi: ACCESSOR_ABI,
    functionName: 'simulate',
    args: [args.to, args.value, args.data, args.operation],
  });
  const data = encodeFunctionData({
    abi: SAFE_ABI,
    functionName: 'simulateAndRevert',
    args: [args.accessor, payload],
  });
  const revertData = await client
    .request({
      method: 'eth_call',
      params: [{ to: args.safeAddress, data }, 'latest'],
    })
    .then(
      () => null,
      (error: unknown) => getRevertData(error),
    );
  return revertData ? decodeSimulation(revertData) : null;
}

/** Revert payload of a JSON-RPC error, wherever the node or viem put it. */
export function getRevertData(error: unknown): Hex | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    const { data, cause } = current as { data?: unknown; cause?: unknown };
    if (isHex(data)) {
      return data;
    }
    const nested = (data as { data?: unknown } | undefined)?.data;
    if (isHex(nested)) {
      return nested;
    }
    current = cause;
  }
  return null;
}

/**
 * `simulateAndRevert` reverts with `success (32) | responseSize (32) | response`, the response being
 * the accessor's `(uint256 estimate, bool success, bytes returnData)`. Null when the payload is not that.
 */
export function decodeSimulation(revertData: Hex): TxSimulation | null {
  if (size(revertData) < 64) {
    return null;
  }
  const accessorRan = hexToBigInt(slice(revertData, 0, 32)) !== BigInt(0);
  const responseSize = Number(hexToBigInt(slice(revertData, 32, 64)));
  if (!accessorRan || size(revertData) < 64 + responseSize) {
    return null;
  }
  try {
    const [estimate, success, returnData] = decodeAbiParameters(
      ACCESSOR_ABI[0].outputs,
      slice(revertData, 64, 64 + responseSize),
    );
    return { estimate, success, returnData };
  } catch {
    return null;
  }
}

/** The `Error(string)` message of a revert; else `fallback`, or the raw data when there is none. */
export function getRevertReason(returnData: Hex, fallback?: string): string {
  // Error(string)
  if (returnData.startsWith('0x08c379a0') && size(returnData) >= 68) {
    try {
      return decodeAbiParameters([{ type: 'string' }], slice(returnData, 4))[0];
    } catch {
      // fall through
    }
  }
  if (fallback !== undefined) return fallback;
  return returnData === '0x' ? 'call reverted' : returnData;
}
