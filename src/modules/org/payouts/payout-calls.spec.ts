import { decodeFunctionData, erc20Abi } from 'viem';
import {
  checkRunSize,
  ERC20_CALL_GAS,
  estimateRunGas,
  NATIVE_CALL_GAS,
  PAYOUT_GAS_BOUND,
  toCall,
  TX_OVERHEAD_GAS,
} from '@/modules/org/payouts/payout-calls';

const R = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

const native = toCall({ recipient: R, token: 'native', amountRaw: 5n });
const erc20 = toCall({ recipient: R, token: USDC, amountRaw: 1000500000n });
// packed MultiSend entry: operation 1 + to 20 + value 32 + data length 32 + data
const NATIVE_EACH = NATIVE_CALL_GAS + 16n * 85n;
const ERC20_EACH = ERC20_CALL_GAS + 16n * (85n + 68n);

describe('toCall', () => {
  it('encodes an ERC20 call with value 0 and transfer data', () => {
    expect(erc20).toMatchObject({ to: USDC, value: 0n, operation: 0 });
    expect(decodeFunctionData({ abi: erc20Abi, data: erc20.data })).toEqual({
      functionName: 'transfer',
      args: [R, 1000500000n],
    });
  });

  it('encodes a native call with the raw value and empty data', () => {
    expect(native).toEqual({ to: R, value: 5n, data: '0x', operation: 0 });
  });
});

describe('estimateRunGas / checkRunSize', () => {
  it('estimates mixed native and ERC20 calls as the sum of their constants plus overhead', () => {
    expect(estimateRunGas([])).toBe(TX_OVERHEAD_GAS);
    expect(estimateRunGas([native, erc20, erc20])).toBe(
      TX_OVERHEAD_GAS + NATIVE_EACH + 2n * ERC20_EACH,
    );
  });

  it('accepts calls whose estimate equals the bound', () => {
    const calls = [native, erc20, erc20];
    const bound = estimateRunGas(calls);
    expect(checkRunSize(calls, bound)).toEqual({
      ok: true,
      estimatedGas: bound,
    });
  });

  it('rejects one call more with maxRecipients equal to the calls that fit', () => {
    const bound = estimateRunGas([native, erc20, erc20]);
    const calls = [native, erc20, erc20, native];
    expect(checkRunSize(calls, bound)).toEqual({
      ok: false,
      estimatedGas: bound + NATIVE_EACH,
      maxRecipients: 3,
    });
  });

  it('fits about 80 ERC20 or 120+ native recipients under the default bound', () => {
    const many = (c: typeof native, n: number): Array<typeof native> =>
      Array.from({ length: n }, () => c);
    const e = checkRunSize(many(erc20, 500));
    const n = checkRunSize(many(native, 500));
    expect(e.ok || n.ok).toBe(false);
    if (e.ok || n.ok) return;
    expect(e.maxRecipients).toBe(81);
    expect(n.maxRecipients).toBe(128);
    expect(checkRunSize(many(erc20, 81)).ok).toBe(true);
    expect(PAYOUT_GAS_BOUND).toBe(6_000_000n);
  });
});
