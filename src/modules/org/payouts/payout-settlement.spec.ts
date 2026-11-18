import {
  encodeFunctionData,
  erc20Abi,
  getAddress,
  parseAbi,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import { multisigTransactionBuilder } from '@/modules/safe/domain/entities/__tests__/multisig-transaction.builder';
import { erc20TransferBuilder } from '@/modules/safe/domain/entities/__tests__/erc20-transfer.builder';
import type { MultisigTransaction } from '@/modules/safe/domain/entities/multisig-transaction.entity';
import type { Transfer } from '@/modules/safe/domain/entities/transfer.entity';
import { multiSendCall } from '@/modules/org/common/__tests__/multisend.builder';
import type { SafeCall } from '@/modules/org/common/multisend';
import { toCall } from '@/modules/org/payouts/payout-calls';
import {
  settlementOutcome,
  type SettlementInput,
} from '@/modules/org/payouts/payout-settlement';

const CHAIN = '84532';
const SAFE = getAddress('0x5afe000000000000000000000000000000000001');
const ALICE = getAddress('0xa11ce00000000000000000000000000000000001');
const BOB = getAddress('0xb0b0000000000000000000000000000000000002');
const CAROL = getAddress('0xca40100000000000000000000000000000000003');
const STRANGER = getAddress('0x5742000000000000000000000000000000000004');
const SOME_CONTRACT = getAddress('0xc0de000000000000000000000000000000000005');
const USDC = getAddress('0x036cbd53842c5426634e7929541ec2318f3dcf7e');
const DAI = getAddress('0xda10000000000000000000000000000000000006');
const CALL_ONLY = getAddress('0x40a2accbd92bca938b02010e17a5b8929b49130d');
const PLAIN_MULTISEND = getAddress(
  '0xa238cbeb142c10ef7ad8442c6d1f9e89e07e7761',
);
const CALL_ONLY_SET = new Set([CALL_ONLY.toLowerCase()]);
const TRUSTED = new Set([
  CALL_ONLY.toLowerCase(),
  PLAIN_MULTISEND.toLowerCase(),
]);
const TX_HASH: Hex = `0x${'ab'.repeat(32)}`;
const OTHER_TX_HASH: Hex = `0x${'cd'.repeat(32)}`;

const EXECUTED_AT = new Date('2026-11-10T12:00:00Z');
const AFTER_MARGIN = new Date(EXECUTED_AT.getTime() + 6 * 60_000);
const VERIFYING_SINCE = AFTER_MARGIN;
const DEADLINE = new Date(VERIFYING_SINCE.getTime() + 24 * 3_600_000);
const BEFORE_DEADLINE = new Date(DEADLINE.getTime() - 1);

type Item = SettlementInput['run']['items'][number];
const ITEMS: Array<Item> = [
  { line: 2, recipient: ALICE, token: 'native', amountRaw: 10n ** 18n },
  { line: 3, recipient: BOB, token: USDC, amountRaw: 1_000_500_000n },
  { line: 4, recipient: CAROL, token: DAI, amountRaw: 5n * 10n ** 18n },
];
const callsOf = (items: ReadonlyArray<Item>): Array<SafeCall> =>
  items.map((i) => toCall(i));
const CALLS = callsOf(ITEMS);

const erc20 = (
  fn: 'transfer' | 'approve',
  token: Address,
  to: Address,
  amount: bigint,
): SafeCall => ({
  to: token,
  value: 0n,
  data: encodeFunctionData({
    abi: erc20Abi,
    functionName: fn,
    args: [to, amount],
  }),
  operation: 0,
});

const safeSettingsAbi = parseAbi([
  'function changeThreshold(uint256 threshold)',
  'function addOwnerWithThreshold(address owner, uint256 threshold)',
  'function enableModule(address module)',
  'function execTransactionFromModule(address to, uint256 value, bytes data, uint8 operation)',
]);
const safeSelf = (
  functionName:
    | 'changeThreshold'
    | 'addOwnerWithThreshold'
    | 'enableModule'
    | 'execTransactionFromModule',
  args: ReadonlyArray<unknown>,
): SafeCall => ({
  to: SAFE,
  value: 0n,
  data: encodeFunctionData({
    abi: safeSettingsAbi,
    functionName,
    args,
  } as never),
  operation: 0,
});

function executed(
  outer: SafeCall,
  overrides: Partial<MultisigTransaction> = {},
): MultisigTransaction {
  return {
    ...multisigTransactionBuilder()
      .with('safe', SAFE)
      .with('nonce', 7)
      .with('to', outer.to)
      .with('value', outer.value.toString())
      .with('data', outer.data)
      .with('operation', outer.operation)
      .with('gasPrice', '0')
      .with('gasToken', zeroAddress)
      .with('refundReceiver', zeroAddress)
      .with('isExecuted', true)
      .with('isSuccessful', true)
      .with('executionDate', EXECUTED_AT)
      .with('transactionHash', TX_HASH)
      .build(),
    ...overrides,
  };
}

const runTx = (
  overrides: Partial<MultisigTransaction> = {},
): MultisigTransaction => executed(multiSendCall(CALL_ONLY, CALLS), overrides);

function transferOf(item: Item, overrides: Partial<Transfer> = {}): Transfer {
  return {
    ...erc20TransferBuilder()
      .with('from', SAFE)
      .with('to', item.recipient)
      .with('tokenAddress', item.token as Address)
      .with('value', item.amountRaw.toString())
      .with('transactionHash', TX_HASH)
      .build(),
    ...overrides,
  } as Transfer;
}
const ALL_TRANSFERS = [transferOf(ITEMS[1]), transferOf(ITEMS[2])];

function input(overrides: Partial<SettlementInput> = {}): SettlementInput {
  return {
    run: { chainId: CHAIN, safeAddress: SAFE, calls: CALLS, items: ITEMS },
    attemptCalls: [],
    executedAtNonce: runTx(),
    transfers: ALL_TRANSFERS,
    trusted: TRUSTED,
    callOnly: CALL_ONLY_SET,
    now: AFTER_MARGIN,
    deadline: DEADLINE,
    ...overrides,
  };
}

const NEEDS_REVIEW_OVERLAP = {
  status: 'needs_review',
  executedTxHash: TX_HASH,
  review: { reason: 'partial_overlap' },
};
const DAN = getAddress('0xda40000000000000000000000000000000000007');
const native = (to: Address, value = 1n): SafeCall => ({
  to,
  value,
  data: '0x',
  operation: 0,
});
const outcomeOf = (tx: MultisigTransaction): unknown =>
  settlementOutcome(input({ executedAtNonce: tx, transfers: [] }));

describe('settlementOutcome', () => {
  describe('no decision yet', () => {
    it('returns pending when nothing executed at the nonce or isSuccessful is null', () => {
      expect(settlementOutcome(input({ executedAtNonce: null }))).toEqual({
        status: 'pending',
      });
      for (const tx of [
        runTx({ isExecuted: false }),
        runTx({ isSuccessful: null }),
        runTx({ value: '1.5' }),
      ])
        expect(settlementOutcome(input({ executedAtNonce: tx }))).toEqual({
          status: 'pending',
        });
    });

    it('keeps verifying within the per-chain reorg margin or without executionDate', () => {
      const at4min = new Date(EXECUTED_AT.getTime() + 4 * 60_000);
      expect(settlementOutcome(input({ now: at4min }))).toEqual({
        status: 'verifying',
        executedTxHash: TX_HASH,
      });
      const at10min = new Date(EXECUTED_AT.getTime() + 10 * 60_000);
      expect(settlementOutcome(input({ now: at10min })).status).toBe(
        'executed',
      );
      const mainnet = input({ now: at10min });
      mainnet.run = { ...mainnet.run, chainId: '1' };
      expect(settlementOutcome(mainnet).status).toBe('verifying');
      expect(
        settlementOutcome(
          input({ executedAtNonce: runTx({ executionDate: null }) }),
        ).status,
      ).toBe('verifying');
    });
  });

  describe('rejection → rejected', () => {
    it('returns rejected for a rejection tx at the nonce', () => {
      const rejection = executed(
        { to: SAFE, value: 0n, data: '0x', operation: 0 },
        { data: null },
      );
      expect(settlementOutcome(input({ executedAtNonce: rejection }))).toEqual({
        status: 'rejected',
        executedTxHash: TX_HASH,
      });
    });
  });

  describe('reverted → failed', () => {
    it('returns failed for the run tx and for any other tx that reverted', () => {
      expect(
        settlementOutcome(
          input({ executedAtNonce: runTx({ isSuccessful: false }) }),
        ),
      ).toEqual({ status: 'failed', executedTxHash: TX_HASH });
      const other = executed(erc20('transfer', USDC, BOB, 1n), {
        isSuccessful: false,
      });
      expect(outcomeOf(other)).toEqual({
        status: 'failed',
        executedTxHash: TX_HASH,
      });
    });
  });

  describe('current calls → executed once every ERC20 item has its transfer', () => {
    it('returns executed when every ERC20 item has its transfer', () => {
      expect(settlementOutcome(input())).toEqual({
        status: 'executed',
        executedTxHash: TX_HASH,
      });
    });

    it('returns executed for a tx with another hash but equal calls at the nonce', () => {
      const tx = runTx({ safeTxHash: OTHER_TX_HASH, safeTxGas: 99 });
      expect(settlementOutcome(input({ executedAtNonce: tx })).status).toBe(
        'executed',
      );
    });

    it('compares null data as 0x, value as bigint and to case-insensitively', () => {
      const items = [ITEMS[0]];
      const tx = executed(toCall(items[0]), {
        to: ALICE.toLowerCase() as Address,
        data: null,
      });
      const base = input({ executedAtNonce: tx, transfers: [] });
      base.run = { ...base.run, calls: callsOf(items), items };
      expect(settlementOutcome(base).status).toBe('executed');
    });

    it('keeps verifying while transfers are missing and returns needs_review missing_transfers with the lines at the deadline', () => {
      expect(
        settlementOutcome(input({ transfers: [], now: BEFORE_DEADLINE })),
      ).toEqual({ status: 'verifying', executedTxHash: TX_HASH });
      expect(
        settlementOutcome(
          input({ transfers: [], deadline: null, now: DEADLINE }),
        ).status,
      ).toBe('verifying');
      expect(
        settlementOutcome(
          input({ transfers: [transferOf(ITEMS[1])], now: DEADLINE }),
        ),
      ).toEqual({
        status: 'needs_review',
        executedTxHash: TX_HASH,
        review: { reason: 'missing_transfers', lines: [4] },
      });
    });

    it('needs one transfer per duplicate row and counts a record once (dedupe by transferId)', () => {
      const items = [ITEMS[1], { ...ITEMS[1], line: 5 }];
      const calls = callsOf(items);
      const record = transferOf(items[0]);
      const base = input({
        executedAtNonce: executed(multiSendCall(CALL_ONLY, calls)),
        transfers: [record, { ...record }],
        now: DEADLINE,
      });
      base.run = { ...base.run, calls, items };
      expect(settlementOutcome(base).review).toEqual({
        reason: 'missing_transfers',
        lines: [5],
      });
      base.transfers = [transferOf(items[0]), transferOf(items[1])];
      expect(settlementOutcome(base).status).toBe('executed');
    });

    it('ignores transfers of another transactionHash and wrong amounts', () => {
      const wrong = [
        transferOf(ITEMS[1], { transactionHash: OTHER_TX_HASH }),
        transferOf(ITEMS[2], { value: '1' } as Partial<Transfer>),
      ];
      expect(
        settlementOutcome(input({ transfers: wrong, now: DEADLINE })).review,
      ).toEqual({ reason: 'missing_transfers', lines: [3, 4] });
    });
  });

  describe('earlier attempt or direct payment to a run recipient → needs_review partial_overlap', () => {
    it('returns partial_overlap when the tx at N carries an earlier attempt of the edited run', () => {
      // the earlier attempt paid STRANGER (since edited out of the run)
      const earlier = [erc20('transfer', USDC, STRANGER, 7n)];
      expect(
        settlementOutcome(
          input({
            executedAtNonce: executed(earlier[0]),
            attemptCalls: [earlier],
            transfers: [],
          }),
        ),
      ).toEqual(NEEDS_REVIEW_OVERLAP);
    });

    it('returns partial_overlap for a payment to a recipient of an earlier attempt only', () => {
      const earlier = [native(STRANGER), erc20('transfer', USDC, DAN, 7n)];
      for (const call of [
        native(STRANGER, 2n),
        erc20('transfer', DAI, DAN, 1n),
      ])
        expect(
          settlementOutcome(
            input({
              executedAtNonce: executed(call),
              attemptCalls: [earlier],
              transfers: [],
            }),
          ),
        ).toEqual(NEEDS_REVIEW_OVERLAP);
    });

    it('returns partial_overlap for the old calls of a pinned draft edited since (calls null)', () => {
      const edited = input({ transfers: [] });
      edited.run = { ...edited.run, calls: null };
      expect(settlementOutcome(edited)).toEqual(NEEDS_REVIEW_OVERLAP);
    });

    it('returns partial_overlap for an ERC20 transfer or transferFrom of any amount to a run recipient', () => {
      expect(outcomeOf(executed(erc20('transfer', DAI, BOB, 1n)))).toEqual(
        NEEDS_REVIEW_OVERLAP,
      );
      const transferFrom: SafeCall = {
        to: USDC,
        value: 0n,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: 'transferFrom',
          args: [SAFE, CAROL, 1n],
        }),
        operation: 0,
      };
      expect(outcomeOf(executed(transferFrom))).toEqual(NEEDS_REVIEW_OVERLAP);
    });

    it('returns partial_overlap for native value to a run recipient inside a nested MultiSend', () => {
      const inner = multiSendCall(PLAIN_MULTISEND, [
        { to: BOB, value: 1n, data: '0x', operation: 0 },
      ]);
      const tx = executed(
        multiSendCall(CALL_ONLY, [
          erc20('transfer', USDC, STRANGER, 5n),
          inner,
        ]),
      );
      expect(outcomeOf(tx)).toEqual(NEEDS_REVIEW_OVERLAP);
    });

    it('returns partial_overlap for a decoded payment in a tx that is otherwise undecodable', () => {
      const tx = executed(
        multiSendCall(CALL_ONLY, [
          erc20('transfer', USDC, ALICE, 5n),
          { to: SOME_CONTRACT, value: 0n, data: '0x', operation: 1 },
        ]),
      );
      expect(outcomeOf(tx)).toEqual(NEEDS_REVIEW_OVERLAP);
    });

    it('returns partial_overlap for a plain MultiSend of the run calls (not the run tx shape)', () => {
      const tx = executed(multiSendCall(PLAIN_MULTISEND, CALLS));
      expect(settlementOutcome(input({ executedAtNonce: tx }))).toEqual(
        NEEDS_REVIEW_OVERLAP,
      );
    });
  });

  describe('anything else → replaced', () => {
    it.each([
      ['a transfer to a stranger', erc20('transfer', USDC, STRANGER, 5n)],
      [
        'native value to a stranger',
        { to: STRANGER, value: 1n, data: '0x' as Hex, operation: 0 as const },
      ],
      [
        'an unrelated contract call',
        {
          to: SOME_CONTRACT,
          value: 0n,
          data: '0x12345678' as Hex,
          operation: 0 as const,
        },
      ],
      ['a settings-only tx', safeSelf('changeThreshold', [2n])],
      ['an approve to a run recipient', erc20('approve', DAI, CAROL, 1n)],
      [
        'a delegatecall to an unknown contract',
        {
          to: SOME_CONTRACT,
          value: 0n,
          data: '0x' as Hex,
          operation: 1 as const,
        },
      ],
      ['a MultiSend of zero calls', multiSendCall(CALL_ONLY, [])],
    ])('returns replaced for %s at N', (_, call) => {
      expect(outcomeOf(executed(call))).toEqual({
        status: 'replaced',
        executedTxHash: TX_HASH,
      });
    });
  });
});
