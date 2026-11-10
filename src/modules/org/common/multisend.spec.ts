import { encodeFunctionData, erc20Abi, getAddress, type Hex } from 'viem';
import {
  flattenCalls,
  unpackMultiSend,
  type SafeCall,
} from '@/modules/org/common/multisend';
import {
  multiSendCall,
  multiSendData,
  packCalls as pack,
} from '@/modules/org/common/__tests__/multisend.builder';

const alice = getAddress('0x00000000000000000000000000000000000a11ce');
const usdc = getAddress('0x0000000000000000000000000000000000005dc0');
const native: SafeCall = {
  to: alice,
  value: 10n ** 18n,
  data: '0x',
  operation: 0,
};
const erc20: SafeCall = {
  to: usdc,
  value: 0n,
  data: encodeFunctionData({
    abi: erc20Abi,
    functionName: 'transfer',
    args: [alice, 1_000_000n],
  }),
  operation: 0,
};

describe('unpackMultiSend', () => {
  it('unpacks a packed MultiSend with native and ERC20 calls', () => {
    expect(unpackMultiSend(multiSendData(pack([native, erc20])))).toEqual([
      native,
      erc20,
    ]);
  });

  it('returns null for trailing bytes', () => {
    expect(
      unpackMultiSend(multiSendData(`${pack([native])}00` as Hex)),
    ).toBeNull();
  });

  it('returns null for a truncated data length', () => {
    // erc20 data is 68 bytes; drop its last byte so the declared length overruns
    expect(
      unpackMultiSend(multiSendData(pack([erc20]).slice(0, -2) as Hex)),
    ).toBeNull();
    // a 60-byte entry: shorter than the 85-byte header
    expect(
      unpackMultiSend(multiSendData(pack([native]).slice(0, 2 + 120) as Hex)),
    ).toBeNull();
    // fewer bytes than one entry header
    expect(
      unpackMultiSend(multiSendData(pack([native]).slice(0, 40) as Hex)),
    ).toBeNull();
  });

  it('returns null for operation 2', () => {
    const bad = `0x02${pack([native]).slice(4)}` as Hex;
    expect(unpackMultiSend(multiSendData(bad))).toBeNull();
  });

  it('returns null for another selector', () => {
    const data = multiSendData(pack([native]));
    expect(unpackMultiSend(`0xdeadbeef${data.slice(10)}` as Hex)).toBeNull();
    expect(unpackMultiSend('0x')).toBeNull();
    expect(unpackMultiSend('0x8d80ff0a')).toBeNull();
  });
});

describe('flattenCalls', () => {
  const MS = getAddress('0x0000000000000000000000000000000000003e5d');
  const trusted = new Set([MS.toLowerCase()]);

  it('flattens nested trusted MultiSends with call paths', () => {
    const tx = multiSendCall(MS, [native, multiSendCall(MS, [erc20])]);
    expect(flattenCalls(tx, trusted)).toEqual({
      ok: true,
      calls: [
        { ...native, callPath: '0' },
        { ...erc20, callPath: '1.0' },
      ],
    });
    expect(flattenCalls(native, trusted)).toEqual({
      ok: true,
      calls: [{ ...native, callPath: '' }],
    });
  });

  it('returns delegatecall for an inner delegatecall to a non-MultiSend target', () => {
    const tx = multiSendCall(MS, [native, { ...erc20, operation: 1 }]);
    expect(flattenCalls(tx, trusted)).toEqual({
      ok: false,
      reason: 'delegatecall',
    });
    expect(flattenCalls(multiSendCall(alice, [native]), trusted)).toEqual({
      ok: false,
      reason: 'delegatecall',
    });
  });

  it('returns nesting_too_deep at depth 3 and undecodable for bad packing', () => {
    const deep = multiSendCall(MS, [
      multiSendCall(MS, [multiSendCall(MS, [native])]),
    ]);
    expect(flattenCalls(deep, trusted)).toEqual({
      ok: false,
      reason: 'nesting_too_deep',
    });
    const bad = {
      to: MS,
      value: 0n,
      data: multiSendData(`${pack([native])}00` as Hex),
      operation: 1 as const,
    };
    expect(flattenCalls(bad, trusted)).toEqual({
      ok: false,
      reason: 'undecodable',
    });
  });
});
