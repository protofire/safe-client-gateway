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
import { nativeTokenTransferBuilder } from '@/modules/safe/domain/entities/__tests__/native-token-transfer.builder';
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

describe('settlementOutcome', () => {
  it('returns pending when nothing executed at the nonce', () => {
    expect(settlementOutcome(input({ executedAtNonce: null }))).toEqual({
      status: 'pending',
    });
    expect(
      settlementOutcome(
        input({ executedAtNonce: runTx({ isExecuted: false }) }),
      ),
    ).toEqual({ status: 'pending' });
  });

  it('returns pending while isSuccessful is null and verifying within the reorg margin', () => {
    expect(
      settlementOutcome(
        input({ executedAtNonce: runTx({ isSuccessful: null }) }),
      ),
    ).toEqual({ status: 'pending' });
    expect(
      settlementOutcome(
        input({ now: new Date(EXECUTED_AT.getTime() + 4 * 60_000) }),
      ).status,
    ).toBe('verifying');
  });

  it('uses the per-chain reorg margin', () => {
    const at10min = new Date(EXECUTED_AT.getTime() + 10 * 60_000);
    expect(settlementOutcome(input({ now: at10min })).status).toBe('executed');
    const polygon = input({ now: at10min });
    polygon.run = { ...polygon.run, chainId: '137' };
    expect(settlementOutcome(polygon).status).toBe('verifying');
    const mainnet = input({ now: at10min });
    mainnet.run = { ...mainnet.run, chainId: '1' };
    expect(settlementOutcome(mainnet).status).toBe('verifying');
  });

  it('treats an executed tx without executionDate as within the reorg margin', () => {
    expect(
      settlementOutcome(
        input({ executedAtNonce: runTx({ executionDate: null }) }),
      ).status,
    ).toBe('verifying');
  });

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

  it("never returns executed for equal calls with a gas refund (H reported, H' with a refund executed)", () => {
    const tx = runTx({
      safeTxHash: OTHER_TX_HASH,
      gasPrice: '5',
      executor: STRANGER,
    });
    expect(settlementOutcome(input({ executedAtNonce: tx }))).toEqual({
      status: 'needs_review',
      executedTxHash: TX_HASH,
      review: { reason: 'partial_overlap' },
    });
  });

  it('needs two transfers for two duplicate rows', () => {
    const items = [ITEMS[1], { ...ITEMS[1], line: 5 }];
    const calls = callsOf(items);
    const base = input({
      executedAtNonce: executed(multiSendCall(CALL_ONLY, calls)),
      transfers: [transferOf(items[0])],
      now: DEADLINE,
    });
    base.run = { ...base.run, calls, items };
    expect(settlementOutcome(base)).toEqual({
      status: 'needs_review',
      executedTxHash: TX_HASH,
      review: { reason: 'missing_transfers', lines: [5] },
    });
    base.transfers = [transferOf(items[0]), transferOf(items[1])];
    expect(settlementOutcome(base).status).toBe('executed');
  });

  it('keeps verifying until the deadline and then returns needs_review for a single false-returning token', () => {
    const items = [ITEMS[1]];
    const calls = callsOf(items);
    const base = input({
      executedAtNonce: executed(calls[0]),
      transfers: [],
      now: BEFORE_DEADLINE,
    });
    base.run = { ...base.run, calls, items };
    expect(settlementOutcome(base).status).toBe('verifying');
    expect(settlementOutcome({ ...base, now: DEADLINE })).toEqual({
      status: 'needs_review',
      executedTxHash: TX_HASH,
      review: { reason: 'missing_transfers', lines: [3] },
    });
  });

  it('returns needs_review missing_transfers with the missing lines at the deadline when some transfers were found', () => {
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

  it('never returns a negative conclusion before the deadline, even after a complete-looking paged read', () => {
    expect(
      settlementOutcome(input({ transfers: [], now: BEFORE_DEADLINE })).status,
    ).toBe('verifying');
    expect(
      settlementOutcome(input({ transfers: [], deadline: null, now: DEADLINE }))
        .status,
    ).toBe('verifying');
  });

  it('upgrades to executed when the transfers appear before the deadline', () => {
    expect(settlementOutcome(input({ transfers: [] })).status).toBe(
      'verifying',
    );
    expect(settlementOutcome(input()).status).toBe('executed');
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

  it('returns failed for isSuccessful false only', () => {
    expect(
      settlementOutcome(
        input({ executedAtNonce: runTx({ isSuccessful: false }) }),
      ),
    ).toEqual({ status: 'failed', executedTxHash: TX_HASH });
    expect(settlementOutcome(input()).status).toBe('executed');
  });

  it('returns rejected for a rejection tx at the nonce', () => {
    const rejection = executed(
      { to: SAFE, value: 0n, data: '0x', operation: 0 },
      {
        data: null,
      },
    );
    expect(settlementOutcome(input({ executedAtNonce: rejection }))).toEqual({
      status: 'rejected',
      executedTxHash: TX_HASH,
    });
  });

  it('never settles replaced for a send of value or tokens to an address it cannot prove harmless: verifying, then indirect_unproven', () => {
    // the Safe's transfers endpoint cannot show a recipient forwarding the money on
    for (const call of [
      erc20('transfer', USDC, STRANGER, 5n),
      { to: STRANGER, value: 1n, data: '0x' as Hex, operation: 0 as const },
      {
        to: SOME_CONTRACT,
        value: 1n,
        data: '0x' as Hex,
        operation: 0 as const,
      },
      erc20('approve', USDC, SOME_CONTRACT, 5n),
    ]) {
      const tx = executed(call);
      expect(
        settlementOutcome(input({ executedAtNonce: tx, transfers: [] })),
      ).toEqual({ status: 'verifying', executedTxHash: TX_HASH });
      expect(
        settlementOutcome(
          input({ executedAtNonce: tx, transfers: [], now: DEADLINE }),
        ),
      ).toEqual({
        status: 'needs_review',
        executedTxHash: TX_HASH,
        review: { reason: 'indirect_unproven' },
      });
    }
  });

  it('never settles replaced for a call to an external contract, even one that looks harmless: verifying, then indirect_unproven', () => {
    // any external call runs code that can pull the Safe's tokens through an earlier allowance
    for (const call of [
      erc20('transfer', USDC, STRANGER, 0n),
      erc20('transfer', USDC, SAFE, 5n),
      erc20('approve', USDC, STRANGER, 0n),
      { to: STRANGER, value: 0n, data: '0x' as Hex, operation: 0 as const },
    ]) {
      const tx = executed(call);
      expect(
        settlementOutcome(input({ executedAtNonce: tx, transfers: [] })),
      ).toEqual({ status: 'verifying', executedTxHash: TX_HASH });
      expect(
        settlementOutcome(
          input({ executedAtNonce: tx, transfers: [], now: DEADLINE }),
        ).review,
      ).toEqual({ reason: 'indirect_unproven' });
    }
  });

  it('never settles replaced for a settings-only tx at N: a guard hook runs on any tx and can pay; verifying, then indirect_unproven', () => {
    const changeThreshold = safeSelf('changeThreshold', [2n]);
    const addOwner = safeSelf('addOwnerWithThreshold', [STRANGER, 2n]);
    for (const tx of [
      executed(changeThreshold),
      executed(safeSelf('enableModule', [SOME_CONTRACT])),
      executed({ to: SAFE, value: 1n, data: '0x', operation: 0 }),
      executed(multiSendCall(CALL_ONLY, [changeThreshold, addOwner])),
    ]) {
      expect(
        settlementOutcome(input({ executedAtNonce: tx, transfers: [] })),
      ).toEqual({ status: 'verifying', executedTxHash: TX_HASH });
      expect(
        settlementOutcome(
          input({ executedAtNonce: tx, transfers: [], now: DEADLINE }),
        ).review,
      ).toEqual({ reason: 'indirect_unproven' });
    }
  });

  it('never settles replaced for a Safe self-call that can run other code: a module execution or the fallback handler', () => {
    for (const call of [
      safeSelf('execTransactionFromModule', [USDC, 0n, '0x', 0]),
      { to: SAFE, value: 0n, data: '0x12345678' as Hex, operation: 0 as const },
    ])
      expect(
        settlementOutcome(
          input({ executedAtNonce: executed(call), transfers: [] }),
        ).status,
      ).toBe('verifying');
  });

  it('returns needs_review partial_overlap for a different-amount ERC20 transfer to a run recipient at N', () => {
    const tx = executed(erc20('transfer', USDC, BOB, 1n));
    expect(
      settlementOutcome(input({ executedAtNonce: tx, transfers: [] })),
    ).toEqual({
      status: 'needs_review',
      executedTxHash: TX_HASH,
      review: { reason: 'partial_overlap' },
    });
  });

  it('returns needs_review partial_overlap for an approve of a run token to its run recipient', () => {
    const tx = executed(erc20('approve', DAI, CAROL, 1n));
    expect(
      settlementOutcome(input({ executedAtNonce: tx, transfers: [] })).review,
    ).toEqual({ reason: 'partial_overlap' });
  });

  it('returns needs_review partial_overlap for a transfer record from the Safe to a run recipient', () => {
    const tx = executed({
      to: SOME_CONTRACT,
      value: 0n,
      data: '0x12345678',
      operation: 0,
    });
    const record = transferOf(ITEMS[1], { value: '1' } as Partial<Transfer>);
    expect(
      settlementOutcome(input({ executedAtNonce: tx, transfers: [record] }))
        .review,
    ).toEqual({ reason: 'partial_overlap' });
  });

  it('returns needs_review partial_overlap for native value to a native recipient inside a nested MultiSend', () => {
    const inner = multiSendCall(PLAIN_MULTISEND, [
      { to: ALICE, value: 1n, data: '0x', operation: 0 },
    ]);
    const tx = executed(
      multiSendCall(CALL_ONLY, [erc20('transfer', USDC, STRANGER, 5n), inner]),
    );
    expect(
      settlementOutcome(input({ executedAtNonce: tx, transfers: [] })).review,
    ).toEqual({ reason: 'partial_overlap' });
  });

  it('returns undecodable for an inner delegatecall to a non-MultiSend target', () => {
    const tx = executed(
      multiSendCall(CALL_ONLY, [
        erc20('transfer', USDC, STRANGER, 5n),
        { to: SOME_CONTRACT, value: 0n, data: '0x', operation: 1 },
      ]),
    );
    expect(
      settlementOutcome(input({ executedAtNonce: tx, transfers: [] })),
    ).toEqual({
      status: 'needs_review',
      executedTxHash: TX_HASH,
      review: { reason: 'undecodable' },
    });
  });

  it('returns needs_review undecodable for a delegatecall to an unknown contract at the nonce', () => {
    const tx = executed({
      to: SOME_CONTRACT,
      value: 0n,
      data: '0x',
      operation: 1,
    });
    expect(
      settlementOutcome(input({ executedAtNonce: tx, transfers: [] })).review,
    ).toEqual({ reason: 'undecodable' });
  });

  it('returns undecodable for a MultiSend of zero calls', () => {
    const tx = executed(multiSendCall(CALL_ONLY, []));
    expect(
      settlementOutcome(input({ executedAtNonce: tx, transfers: [] })).review,
    ).toEqual({ reason: 'undecodable' });
  });

  it('returns needs_review partial_overlap when the tx at N is an earlier attempt version of the edited run', () => {
    // earlier attempt paid STRANGER (since edited out of the run)
    const earlier = [erc20('transfer', USDC, STRANGER, 7n)];
    const tx = executed(earlier[0]);
    expect(
      settlementOutcome(
        input({ executedAtNonce: tx, attemptCalls: [earlier], transfers: [] }),
      ),
    ).toEqual({
      status: 'needs_review',
      executedTxHash: TX_HASH,
      review: { reason: 'partial_overlap' },
    });
  });

  it('keeps verifying for an unrelated contract call at N until the deadline, then needs_review indirect_unproven', () => {
    const tx = executed({
      to: SOME_CONTRACT,
      value: 0n,
      data: '0x12345678',
      operation: 0,
    });
    expect(
      settlementOutcome(
        input({ executedAtNonce: tx, transfers: [], now: BEFORE_DEADLINE }),
      ),
    ).toEqual({ status: 'verifying', executedTxHash: TX_HASH });
    expect(
      settlementOutcome(
        input({ executedAtNonce: tx, transfers: [], now: DEADLINE }),
      ),
    ).toEqual({
      status: 'needs_review',
      executedTxHash: TX_HASH,
      review: { reason: 'indirect_unproven' },
    });
  });

  it('judges a tx at N by attempt and item overlap only when the edited pinned draft has calls null', () => {
    const edited = input({ transfers: [] });
    edited.run = { ...edited.run, calls: null };
    // the run's own previously built calls executed: overlap with its items, never executed/replaced
    expect(settlementOutcome(edited)).toEqual({
      status: 'needs_review',
      executedTxHash: TX_HASH,
      review: { reason: 'partial_overlap' },
    });
    edited.executedAtNonce = executed(safeSelf('changeThreshold', [2n]));
    expect(settlementOutcome(edited).status).toBe('verifying');
    edited.executedAtNonce = executed(erc20('transfer', USDC, STRANGER, 5n));
    expect(settlementOutcome(edited).status).toBe('verifying');
  });

  it('compares null data as 0x, value as bigint and to case-insensitively in the direct-call branch', () => {
    const items = [ITEMS[0]];
    const tx = executed(toCall(items[0]), {
      to: ALICE.toLowerCase() as Address,
      data: null,
    });
    const base = input({ executedAtNonce: tx, transfers: [] });
    base.run = { ...base.run, calls: callsOf(items), items };
    expect(settlementOutcome(base).status).toBe('executed');
  });

  it('does not treat a plain MultiSend of equal calls as the run tx', () => {
    const tx = executed(multiSendCall(PLAIN_MULTISEND, CALLS));
    expect(settlementOutcome(input({ executedAtNonce: tx })).review).toEqual({
      reason: 'partial_overlap',
    });
  });

  describe('gas refund (gasPrice > 0) is a payment path', () => {
    const refund = {
      gasPrice: '1',
      gasToken: zeroAddress,
      refundReceiver: zeroAddress,
      executor: STRANGER,
    } satisfies Partial<MultisigTransaction>;
    const unrelated = (o: Partial<MultisigTransaction>): MultisigTransaction =>
      executed(erc20('approve', USDC, STRANGER, 0n), o);

    it('A: never replaced; verifying, then indirect_unproven at the deadline', () => {
      const tx = unrelated(refund);
      expect(
        settlementOutcome(input({ executedAtNonce: tx, transfers: [] })),
      ).toEqual({ status: 'verifying', executedTxHash: TX_HASH });
      expect(
        settlementOutcome(
          input({ executedAtNonce: tx, transfers: [], now: DEADLINE }),
        ).review,
      ).toEqual({ reason: 'indirect_unproven' });
    });

    it('B: a rejection tx with a refund is never rejected', () => {
      const tx = executed(
        { to: SAFE, value: 0n, data: '0x', operation: 0 },
        { ...refund, data: null },
      );
      expect(
        settlementOutcome(input({ executedAtNonce: tx, transfers: [] })).status,
      ).toBe('verifying');
      expect(
        settlementOutcome(
          input({ executedAtNonce: tx, transfers: [], now: DEADLINE }),
        ).review,
      ).toEqual({ reason: 'indirect_unproven' });
    });

    it('C: equal calls that failed with a refund are never failed', () => {
      const tx = runTx({ ...refund, isSuccessful: false });
      expect(settlementOutcome(input({ executedAtNonce: tx }))).toEqual({
        status: 'needs_review',
        executedTxHash: TX_HASH,
        review: { reason: 'partial_overlap' },
      });
    });

    it('returns partial_overlap when the refund goes to a run recipient', () => {
      // native refund to the executor, who is a native run recipient
      expect(
        settlementOutcome(
          input({
            executedAtNonce: unrelated({ ...refund, executor: ALICE }),
            transfers: [],
          }),
        ).review,
      ).toEqual({ reason: 'partial_overlap' });
      // run-token refund to an explicit refundReceiver who is that token's recipient
      expect(
        settlementOutcome(
          input({
            executedAtNonce: runTx({
              ...refund,
              gasToken: USDC,
              refundReceiver: BOB,
            }),
          }),
        ).review,
      ).toEqual({ reason: 'partial_overlap' });
    });

    it('returns partial_overlap when the refund receiver is any run recipient, whatever the token', () => {
      // native refund to an ERC20 recipient; DAI refund to the native recipient; USDC refund to the DAI recipient
      for (const o of [
        { refundReceiver: BOB },
        { gasToken: DAI, refundReceiver: ALICE },
        { gasToken: USDC, refundReceiver: CAROL },
      ])
        expect(
          settlementOutcome(
            input({
              executedAtNonce: runTx({ ...refund, ...o }),
              transfers: [],
            }),
          ).review,
        ).toEqual({ reason: 'partial_overlap' });
    });

    it('does not conclude when the refund receiver is unknown (zero refundReceiver, no executor)', () => {
      const tx = runTx({ ...refund, executor: null });
      expect(settlementOutcome(input({ executedAtNonce: tx }))).toEqual({
        status: 'verifying',
        executedTxHash: TX_HASH,
      });
      expect(
        settlementOutcome(input({ executedAtNonce: tx, now: DEADLINE })).review,
      ).toEqual({ reason: 'indirect_unproven' });
    });

    it('returns partial_overlap, never executed, for equal successful calls with an unrelated refund', () => {
      expect(
        settlementOutcome(input({ executedAtNonce: runTx(refund) })),
      ).toEqual({
        status: 'needs_review',
        executedTxHash: TX_HASH,
        review: { reason: 'partial_overlap' },
      });
    });
  });

  it('returns replaced for an unrelated tx at N that failed without a refund', () => {
    const tx = executed(
      { to: SOME_CONTRACT, value: 0n, data: '0x12345678', operation: 0 },
      { isSuccessful: false },
    );
    expect(
      settlementOutcome(input({ executedAtNonce: tx, transfers: [] })).status,
    ).toBe('replaced');
  });

  it('counts the same transfer record once (dedupe by transferId)', () => {
    const items = [ITEMS[1], { ...ITEMS[1], line: 5 }];
    const calls = callsOf(items);
    const record = transferOf(items[0]);
    const base = input({
      executedAtNonce: executed(multiSendCall(CALL_ONLY, calls)),
      transfers: [record, { ...record }],
    });
    base.run = { ...base.run, calls, items };
    expect(settlementOutcome(base).status).toBe('verifying');
    expect(settlementOutcome({ ...base, now: DEADLINE }).review).toEqual({
      reason: 'missing_transfers',
      lines: [5],
    });
  });

  it('does not treat an approve(recipient, 0) revocation as overlap, but cannot prove it harmless either', () => {
    const tx = executed(erc20('approve', DAI, CAROL, 0n));
    expect(
      settlementOutcome(input({ executedAtNonce: tx, transfers: [] })),
    ).toEqual({ status: 'verifying', executedTxHash: TX_HASH });
  });

  it('does not treat a payment-shaped call that also sends value as unable to pay indirectly', () => {
    const tx = executed({
      ...erc20('transfer', USDC, STRANGER, 5n),
      value: 1n,
    });
    expect(
      settlementOutcome(input({ executedAtNonce: tx, transfers: [] })).status,
    ).toBe('verifying');
  });

  it('returns partial_overlap for a native transfer record from the Safe to a native recipient', () => {
    const tx = executed({
      to: SOME_CONTRACT,
      value: 0n,
      data: '0x12345678',
      operation: 0,
    });
    const record = {
      ...nativeTokenTransferBuilder()
        .with('from', SAFE)
        .with('to', ALICE)
        .with('value', '1')
        .with('transactionHash', TX_HASH)
        .build(),
    } as Transfer;
    expect(
      settlementOutcome(input({ executedAtNonce: tx, transfers: [record] }))
        .review,
    ).toEqual({ reason: 'partial_overlap' });
  });

  it('never settles replaced for a plain native send to a contract: a forwarding hop is not in the Safe transfers', () => {
    const tx = executed({
      to: SOME_CONTRACT,
      value: 1n,
      data: '0x',
      operation: 0,
    });
    expect(
      settlementOutcome(input({ executedAtNonce: tx, transfers: [] })),
    ).toEqual({ status: 'verifying', executedTxHash: TX_HASH });
    expect(
      settlementOutcome(
        input({ executedAtNonce: tx, transfers: [], now: DEADLINE }),
      ).review,
    ).toEqual({ reason: 'indirect_unproven' });
  });

  it('makes no decision when tx-service numbers are not integers', () => {
    expect(
      settlementOutcome(input({ executedAtNonce: runTx({ value: '1.5' }) })),
    ).toEqual({ status: 'pending' });
    expect(
      settlementOutcome(input({ executedAtNonce: runTx({ gasPrice: 'x' }) })),
    ).toEqual({ status: 'pending' });
  });

  it('makes no decision while gasPrice is unknown (null)', () => {
    expect(
      settlementOutcome(input({ executedAtNonce: runTx({ gasPrice: null }) })),
    ).toEqual({ status: 'pending' });
  });
});
