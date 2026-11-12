import {
  concatHex,
  encodeAbiParameters,
  encodeErrorResult,
  numberToHex,
  parseAbi,
  size,
  type Hex,
} from 'viem';
import {
  decodeSimulation,
  getRevertData,
  getRevertReason,
  simulateSafeCall,
} from '@/domain/common/utils/simulate-tx-accessor';

/** What `simulateAndRevert` reverts with: success | responseSize | accessor (estimate, success, returnData) */
function revertData(estimate: bigint, success: boolean, returnData: Hex): Hex {
  const response = encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'bool' }, { type: 'bytes' }],
    [estimate, success, returnData],
  );
  return concatHex([
    numberToHex(1, { size: 32 }),
    numberToHex(size(response), { size: 32 }),
    response,
  ]);
}

const errorString = (reason: string): Hex =>
  encodeErrorResult({
    abi: parseAbi(['error Error(string)']),
    errorName: 'Error',
    args: [reason],
  });

describe('simulate-tx-accessor', () => {
  it('decodes a simulation result', () => {
    expect(decodeSimulation(revertData(21_000n, true, '0x'))).toEqual({
      estimate: 21_000n,
      success: true,
      returnData: '0x',
    });
  });

  it('decodes nothing from a payload that is not a simulation result', () => {
    expect(decodeSimulation('0x')).toBeNull();
    expect(decodeSimulation(errorString('GS013'))).toBeNull();
    // the accessor did not run
    expect(
      decodeSimulation(
        concatHex([numberToHex(0, { size: 32 }), numberToHex(0, { size: 32 })]),
      ),
    ).toBeNull();
  });

  it('finds revert data in nested errors', () => {
    const data = revertData(1n, true, '0x');
    expect(getRevertData({ cause: { cause: { data } } })).toBe(data);
    expect(getRevertData({ data: { data } })).toBe(data);
    expect(getRevertData(new Error('timeout'))).toBeNull();
  });

  it('decodes Error(string), else falls back', () => {
    expect(getRevertReason(errorString('insufficient'))).toBe('insufficient');
    expect(getRevertReason('0x')).toBe('call reverted');
    expect(getRevertReason('0x1234')).toBe('0x1234');
    expect(getRevertReason('0x', 'fallback')).toBe('fallback');
    expect(getRevertReason(errorString('x'), 'fallback')).toBe('x');
  });

  it('simulates through eth_call and reads the revert', async () => {
    const request = jest.fn().mockRejectedValue(
      Object.assign(new Error('execution reverted'), {
        data: revertData(50_000n, false, errorString('boom')),
      }),
    );
    const result = await simulateSafeCall({ request } as never, {
      safeAddress: '0x00000000000000000000000000000000000000a1',
      accessor: '0x3d4BA2E0884aa488718476ca2FB8Efc291A46199',
      to: '0x00000000000000000000000000000000000000b2',
      value: 0n,
      data: '0x',
      operation: 1,
    });
    expect(result).toEqual({
      estimate: 50_000n,
      success: false,
      returnData: errorString('boom'),
    });
    expect(request).toHaveBeenCalledWith({
      method: 'eth_call',
      params: [
        {
          to: '0x00000000000000000000000000000000000000a1',
          data: expect.stringMatching(/^0xb4faba09/),
        },
        'latest',
      ],
    });
    request.mockRejectedValue(new Error('timeout'));
    await expect(
      simulateSafeCall({ request } as never, {
        safeAddress: '0x00000000000000000000000000000000000000a1',
        accessor: '0x3d4BA2E0884aa488718476ca2FB8Efc291A46199',
        to: '0x00000000000000000000000000000000000000b2',
        value: 0n,
        data: '0x',
        operation: 1,
      }),
    ).resolves.toBeNull();
  });

  // eth_call on Base Sepolia (2026-11-11): Safe 1.4.1 0x1Cc2…4a18 holding ~16.69 USDC, transfer of 20 USDC
  describe('real Base Sepolia reverts', () => {
    const hex = (parts: Array<string>): Hex => `0x${parts.join('')}`;

    it('MultiSendCallOnly 1.4.1 drops the inner reason: empty returnData, so the generic text', () => {
      const raw = hex([
        '0000000000000000000000000000000000000000000000000000000000000001',
        '0000000000000000000000000000000000000000000000000000000000000080',
        '00000000000000000000000000000000000000000000000000000000000051d9',
        '0000000000000000000000000000000000000000000000000000000000000000',
        '0000000000000000000000000000000000000000000000000000000000000060',
        '0000000000000000000000000000000000000000000000000000000000000000',
      ]);
      const sim = decodeSimulation(raw);
      expect(sim).toEqual({
        estimate: 20_953n,
        success: false,
        returnData: '0x',
      });
      expect(getRevertReason(sim!.returnData, 'generic')).toBe('generic');
    });

    it('the direct token call keeps the Error(string) reason', () => {
      const raw = hex([
        '0000000000000000000000000000000000000000000000000000000000000001',
        '0000000000000000000000000000000000000000000000000000000000000120',
        '000000000000000000000000000000000000000000000000000000000000449b',
        '0000000000000000000000000000000000000000000000000000000000000000',
        '0000000000000000000000000000000000000000000000000000000000000060',
        '0000000000000000000000000000000000000000000000000000000000000084',
        '08c379a000000000000000000000000000000000000000000000000000000000',
        '0000002000000000000000000000000000000000000000000000000000000000',
        '0000002645524332303a207472616e7366657220616d6f756e74206578636565',
        '64732062616c616e636500000000000000000000000000000000000000000000',
        '0000000000000000000000000000000000000000000000000000000000000000',
      ]);
      const sim = decodeSimulation(raw);
      expect(sim).toMatchObject({ estimate: 17_563n, success: false });
      expect(getRevertReason(sim!.returnData, 'generic')).toBe(
        'ERC20: transfer amount exceeds balance',
      );
    });
  });
});
