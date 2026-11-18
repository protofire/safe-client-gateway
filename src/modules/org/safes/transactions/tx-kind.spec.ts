import {
  encodeFunctionData,
  getAddress,
  numberToHex,
  parseAbi,
  type Abi,
  type AbiFunction,
  type Hex,
} from 'viem';
import { txKind } from '@/modules/org/safes/transactions/tx-kind';
import {
  multiSendCall,
  multiSendData,
  packCalls,
} from '@/modules/org/common/__tests__/multisend.builder';

const SAFE = getAddress(numberToHex(1, { size: 20 }));
const OTHER = getAddress(numberToHex(2, { size: 20 }));
const MULTISEND = getAddress(numberToHex(3, { size: 20 }));

const call = (sig: string, args: Array<unknown>): Hex => {
  const abi: Abi = parseAbi([`function ${sig}`] as Array<string>);
  return encodeFunctionData({
    abi,
    functionName: (abi[0] as AbiFunction).name,
    args,
  });
};

describe('txKind', () => {
  const plain = {
    to: OTHER,
    value: 1n,
    data: '0x' as Hex,
    operation: 0 as const,
  };

  it.each<
    [string, { to: `0x${string}`; value: string; data: Hex | null }, string]
  >([
    ['native transfer', { to: OTHER, value: '5', data: null }, 'transfer'],
    [
      'ERC-20 transfer',
      {
        to: OTHER,
        value: '0',
        data: call('transfer(address,uint256)', [OTHER, 1n]),
      },
      'transfer',
    ],
    [
      'transferFrom',
      {
        to: OTHER,
        value: '0',
        data: call('transferFrom(address,address,uint256)', [SAFE, OTHER, 1n]),
      },
      'transfer',
    ],
    [
      'ERC-721 safeTransferFrom',
      {
        to: OTHER,
        value: '0',
        data: call('safeTransferFrom(address,address,uint256)', [
          SAFE,
          OTHER,
          1n,
        ]),
      },
      'transfer',
    ],
    ['on-chain rejection', { to: SAFE, value: '0', data: '0x' }, 'rejection'],
    [
      'rejection with null data',
      { to: SAFE, value: '0', data: null },
      'rejection',
    ],
    [
      'add owner',
      {
        to: SAFE,
        value: '0',
        data: call('addOwnerWithThreshold(address,uint256)', [OTHER, 2n]),
      },
      'settings',
    ],
    [
      'change threshold',
      { to: SAFE, value: '0', data: call('changeThreshold(uint256)', [2n]) },
      'settings',
    ],
    [
      'set guard',
      { to: SAFE, value: '0', data: call('setGuard(address)', [OTHER]) },
      'settings',
    ],
    [
      'settings selector on another contract',
      { to: OTHER, value: '0', data: call('changeThreshold(uint256)', [2n]) },
      'contract',
    ],
    [
      'batch',
      {
        to: MULTISEND,
        value: '0',
        data: multiSendData(packCalls([plain, plain])),
      },
      'batch',
    ],
    [
      'nested batch',
      {
        to: MULTISEND,
        value: '0',
        data: multiSendData(
          packCalls([multiSendCall(MULTISEND, [plain]), plain]),
        ),
      },
      'batch',
    ],
    [
      'malformed MultiSend',
      { to: MULTISEND, value: '0', data: multiSendData('0x01') },
      'contract',
    ],
    [
      'contract call',
      {
        to: OTHER,
        value: '0',
        data: call('approve(address,uint256)', [OTHER, 1n]),
      },
      'contract',
    ],
    [
      'zero-value empty call to another address',
      { to: OTHER, value: '0', data: null },
      'contract',
    ],
  ])('%s', (_, tx, kind) => {
    expect(txKind(tx as Parameters<typeof txKind>[0], SAFE)).toBe(kind);
  });

  it('a delegatecall that is not a MultiSend is a contract call', () => {
    const data = call('setup(address)', [OTHER]);
    expect(txKind({ to: OTHER, value: '0', data }, SAFE)).toBe('contract');
  });
});
