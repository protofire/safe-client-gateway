import {
  decodeFunctionData,
  getAddress,
  hexToBigInt,
  hexToNumber,
  parseAbi,
  size,
  slice,
  type Address,
  type Hex,
} from 'viem';

export type SafeCall = {
  to: Address;
  value: bigint;
  data: Hex;
  operation: 0 | 1;
};

export type FlatCall = SafeCall & { callPath: string };

export type FlattenIssue = {
  reason: 'undecodable' | 'nesting_too_deep' | 'delegatecall';
  callPath: string;
  to: Address;
};

const multiSendAbi = parseAbi(['function multiSend(bytes transactions)']);
// operation (1) + to (20) + value (32) + data length (32)
const HEADER = 85;
const MAX_DEPTH = 2;

/**
 * Strict unpacking of `multiSend(bytes)` calldata. Unlike the gateway's
 * MultiSendDecoder it never swallows errors: any malformation yields null.
 */
export function unpackMultiSend(data: Hex): Array<SafeCall> | null {
  try {
    const { functionName, args } = decodeFunctionData({
      abi: multiSendAbi,
      data,
    });
    if (functionName !== 'multiSend') return null;
    const packed = args[0];
    const total = size(packed);
    const calls: Array<SafeCall> = [];
    let at = 0;
    while (at < total) {
      if (total - at < HEADER) return null;
      const operation = hexToNumber(slice(packed, at, at + 1));
      if (operation > 1) return null;
      const length = hexToBigInt(slice(packed, at + 53, at + 85));
      if (length > BigInt(total - at - HEADER)) return null;
      const end = at + HEADER + Number(length);
      calls.push({
        operation: operation as 0 | 1,
        to: getAddress(slice(packed, at + 1, at + 21)),
        value: hexToBigInt(slice(packed, at + 21, at + 53)),
        data: length === 0n ? '0x' : slice(packed, at + HEADER, end),
      });
      at = end;
    }
    return calls;
  } catch {
    return null;
  }
}

/**
 * Walks a Safe transaction, unpacking delegatecalls to trusted MultiSend
 * contracts up to depth 2. Returns every plain call it could reach and every
 * part it could not check; never stops early, so callers can report both.
 */
export function walkCalls(
  tx: SafeCall,
  trustedMultiSend: ReadonlySet<string>,
): { calls: Array<FlatCall>; issues: Array<FlattenIssue> } {
  const calls: Array<FlatCall> = [];
  const issues: Array<FlattenIssue> = [];
  const visit = (call: SafeCall, callPath: string, depth: number): void => {
    if (call.operation === 0) {
      calls.push({ ...call, callPath });
      return;
    }
    const issue = (reason: FlattenIssue['reason']): void => {
      issues.push({ reason, callPath, to: call.to });
    };
    if (!trustedMultiSend.has(call.to.toLowerCase()))
      return issue('delegatecall');
    if (depth >= MAX_DEPTH) return issue('nesting_too_deep');
    const inner = unpackMultiSend(call.data);
    if (inner === null) return issue('undecodable');
    inner.forEach((c, i) =>
      visit(c, callPath === '' ? `${i}` : `${callPath}.${i}`, depth + 1),
    );
  };
  visit(tx, '', 0);
  return { calls, issues };
}

/**
 * All plain calls of a Safe transaction, or why it cannot be fully decoded.
 * An empty `multiSend(0x)` decodes to zero calls (`ok: true, calls: []`);
 * B7 must treat zero calls as undecodable, since nothing in it can match a run.
 */
export function flattenCalls(
  tx: SafeCall,
  trustedMultiSend: ReadonlySet<string>,
):
  | { ok: true; calls: Array<FlatCall> }
  | { ok: false; reason: FlattenIssue['reason'] } {
  const { calls, issues } = walkCalls(tx, trustedMultiSend);
  return issues.length === 0
    ? { ok: true, calls }
    : { ok: false, reason: issues[0].reason };
}
