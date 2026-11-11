import { getAddress, zeroAddress, type Address } from 'viem';
import { multisigTransactionBuilder } from '@/modules/safe/domain/entities/__tests__/multisig-transaction.builder';
import type { MultisigTransaction } from '@/modules/safe/domain/entities/multisig-transaction.entity';
import { multiSendCall } from '@/modules/org/common/__tests__/multisend.builder';
import type { SafeCall } from '@/modules/org/common/multisend';
import { toCall } from '@/modules/org/payouts/payout-calls';
import {
  callsEqual,
  multiSendCallOnlySet,
  reorgMarginMs,
  verifyProposedTx,
} from '@/modules/org/payouts/payout-verify';

const SAFE = getAddress('0x5afe000000000000000000000000000000000001');
const ALICE = getAddress('0xa11ce00000000000000000000000000000000001');
const BOB = getAddress('0xb0b0000000000000000000000000000000000002');
const USDC = getAddress('0x036cbd53842c5426634e7929541ec2318f3dcf7e');
// MultiSendCallOnly 1.3.0 / MultiSend 1.3.0 canonical addresses
const CALL_ONLY = getAddress('0x40a2accbd92bca938b02010e17a5b8929b49130d');
const PLAIN_MULTISEND = getAddress(
  '0xa238cbeb142c10ef7ad8442c6d1f9e89e07e7761',
);
const CALL_ONLY_SET = new Set([CALL_ONLY.toLowerCase()]);
const NONCE = 7n;

const CALLS: Array<SafeCall> = [
  toCall({ recipient: ALICE, token: 'native', amountRaw: 10n ** 18n }),
  toCall({ recipient: BOB, token: USDC, amountRaw: 1_000_500_000n }),
];

function txOf(outer: SafeCall): MultisigTransaction {
  return multisigTransactionBuilder()
    .with('safe', SAFE)
    .with('nonce', Number(NONCE))
    .with('to', outer.to)
    .with('value', outer.value.toString())
    .with('data', outer.data)
    .with('operation', outer.operation)
    .with('gasPrice', '0')
    .with('gasToken', zeroAddress)
    .with('refundReceiver', zeroAddress)
    .with('safeTxGas', 0)
    .with('isExecuted', false)
    .build();
}

const run = (
  calls: ReadonlyArray<SafeCall> = CALLS,
): {
  safeAddress: Address;
  nonce: bigint;
  calls: ReadonlyArray<SafeCall>;
} => ({ safeAddress: SAFE, nonce: NONCE, calls });

const multiTx = (calls: ReadonlyArray<SafeCall> = CALLS): MultisigTransaction =>
  txOf(multiSendCall(CALL_ONLY, calls));

const verify = (
  tx: MultisigTransaction,
  r = run(),
): ReturnType<typeof verifyProposedTx> =>
  verifyProposedTx(tx, r, CALL_ONLY_SET);

const mismatch = (field: string): unknown => ({
  ok: false,
  code: 'tx_mismatch',
  field,
});

describe('verifyProposedTx', () => {
  it('accepts a MultiSendCallOnly tx of native and ERC20 calls whose unpacked calls equal the run calls', () => {
    expect(verify(multiTx())).toEqual({ ok: true });
  });

  it('accepts a one-recipient run proposed as a direct call', () => {
    expect(verify(txOf(CALLS[1]), run([CALLS[1]]))).toEqual({ ok: true });
  });

  it('accepts an already executed matching tx', () => {
    const tx = { ...multiTx(), isExecuted: true, isSuccessful: true };
    expect(verify(tx)).toEqual({ ok: true });
  });

  it('accepts null gasPrice, gasToken and refundReceiver', () => {
    const tx = {
      ...multiTx(),
      gasPrice: null,
      gasToken: null,
      refundReceiver: null,
      safeTxGas: null,
    };
    expect(verify(tx)).toEqual({ ok: true });
  });

  it('accepts any safeTxGas (legacy Safes need one; it can only make the tx fail)', () => {
    expect(verify({ ...multiTx(), safeTxGas: 1 })).toEqual({ ok: true });
    expect(verify({ ...multiTx(), safeTxGas: 250_000 })).toEqual({ ok: true });
  });

  it('reports the first tampered field in the documented order', () => {
    expect(verify({ ...multiTx(), safe: ALICE, gasPrice: '1' })).toEqual(
      mismatch('safe'),
    );
    expect(verify({ ...multiTx(), nonce: 8, gasToken: USDC })).toEqual(
      mismatch('nonce'),
    );
    expect(
      verify({ ...multiTx([CALLS[1], CALLS[0]]), refundReceiver: BOB }),
    ).toEqual(mismatch('refundReceiver'));
    expect(verify({ ...multiTx(), safeTxGas: 1, value: '1' })).toEqual(
      mismatch('value'),
    );
    expect(verify({ ...multiTx(), operation: 0, value: '1' })).toEqual(
      mismatch('operation'),
    );
  });

  it('treats non-integer tx-service numbers as a mismatch instead of throwing', () => {
    expect(verify({ ...multiTx(), gasPrice: '1.5' })).toEqual(
      mismatch('gasPrice'),
    );
    expect(verify({ ...multiTx(), value: 'abc' })).toEqual(mismatch('value'));
    expect(verify({ ...multiTx(), nonce: 7.5 })).toEqual(mismatch('nonce'));
  });

  it('rejects a tx of another Safe', () => {
    expect(verify({ ...multiTx(), safe: ALICE })).toEqual(mismatch('safe'));
  });

  it('rejects a tx at another nonce than the pinned one', () => {
    expect(verify({ ...multiTx(), nonce: 8 })).toEqual(mismatch('nonce'));
  });

  it('rejects plain MultiSend as a multisend mismatch', () => {
    expect(verify(txOf(multiSendCall(PLAIN_MULTISEND, CALLS)))).toEqual(
      mismatch('multisend'),
    );
  });

  it('rejects an unknown outer target as a multisend mismatch', () => {
    expect(verify(txOf(multiSendCall(BOB, CALLS)))).toEqual(
      mismatch('multisend'),
    );
  });

  it('rejects outer operation 0 for a multi-call run', () => {
    expect(verify({ ...multiTx(), operation: 0 })).toEqual(
      mismatch('operation'),
    );
  });

  it('rejects outer value > 0', () => {
    expect(verify({ ...multiTx(), value: '1' })).toEqual(mismatch('value'));
  });

  it('rejects an inner delegatecall', () => {
    const inner = [CALLS[0], { ...CALLS[1], operation: 1 as const }];
    expect(verify(multiTx(inner))).toEqual(mismatch('calls.1.operation'));
  });

  it('rejects gasPrice 1', () => {
    expect(verify({ ...multiTx(), gasPrice: '1' })).toEqual(
      mismatch('gasPrice'),
    );
  });

  it('rejects a non-zero gasToken', () => {
    expect(verify({ ...multiTx(), gasToken: USDC })).toEqual(
      mismatch('gasToken'),
    );
  });

  it('rejects a non-zero refundReceiver', () => {
    expect(verify({ ...multiTx(), refundReceiver: BOB })).toEqual(
      mismatch('refundReceiver'),
    );
  });

  it('rejects one changed recipient', () => {
    const inner = [{ ...CALLS[0], to: BOB }, CALLS[1]];
    expect(verify(multiTx(inner))).toEqual(mismatch('calls.0.to'));
  });

  it('rejects one changed amount', () => {
    const inner = [{ ...CALLS[0], value: CALLS[0].value + 1n }, CALLS[1]];
    expect(verify(multiTx(inner))).toEqual(mismatch('calls.0.value'));
  });

  it('rejects changed calldata', () => {
    const other = toCall({
      recipient: ALICE,
      token: USDC,
      amountRaw: 1_000_500_000n,
    });
    expect(verify(multiTx([CALLS[0], other]))).toEqual(
      mismatch('calls.1.data'),
    );
  });

  it('rejects a missing and an extra call', () => {
    expect(verify(multiTx([CALLS[0]]))).toEqual(mismatch('calls'));
    expect(verify(multiTx([...CALLS, CALLS[0]]))).toEqual(mismatch('calls'));
  });

  it('rejects reordered calls', () => {
    expect(verify(multiTx([CALLS[1], CALLS[0]]))).toEqual(
      mismatch('calls.0.to'),
    );
  });

  it('rejects undecodable outer data', () => {
    expect(verify({ ...multiTx(), data: '0x8d80ff0a00' })).toEqual(
      mismatch('data'),
    );
  });

  it('rejects a direct call with operation 1', () => {
    const tx = { ...txOf(CALLS[1]), operation: 1 as const };
    expect(verify(tx, run([CALLS[1]]))).toEqual(mismatch('operation'));
  });

  it('compares null data as 0x, value as bigint and to case-insensitively in the direct-call branch', () => {
    const native = CALLS[0];
    const tx = {
      ...txOf(native),
      to: native.to.toLowerCase() as Address,
      data: null,
      value: native.value.toString(),
    };
    expect(verify(tx, run([native]))).toEqual({ ok: true });
    expect(verify({ ...tx, value: '1' }, run([native]))).toEqual(
      mismatch('value'),
    );
  });
});

describe('callsEqual', () => {
  it('normalises address case and data case', () => {
    const a = CALLS[1];
    const b = {
      ...a,
      to: a.to.toLowerCase() as Address,
      data: a.data.toUpperCase().replace('0X', '0x') as SafeCall['data'],
    };
    expect(callsEqual(a, b)).toBe(true);
    expect(callsEqual(a, { ...a, value: 1n })).toBe(false);
  });
});

describe('multiSendCallOnlySet', () => {
  const custom = getAddress('0x00000000000000000000000000000000000c0de1');

  it('contains the canonical MultiSendCallOnly, not plain MultiSend, and ignores the chain config where deployments exist', () => {
    const set = multiSendCallOnlySet('84532', custom);
    expect(set.has(CALL_ONLY.toLowerCase())).toBe(true);
    expect(set.has(custom.toLowerCase())).toBe(false);
    expect(set.has(PLAIN_MULTISEND.toLowerCase())).toBe(false);
  });

  it('uses the chain config address only for a chain without deployments', () => {
    expect([...multiSendCallOnlySet('424242424242', custom)]).toEqual([
      custom.toLowerCase(),
    ]);
    expect(multiSendCallOnlySet('424242424242').size).toBe(0);
  });
});

describe('reorgMarginMs', () => {
  it('uses 5 minutes by default, 15 for Ethereum-like finality and 30 for weak finality', () => {
    expect(reorgMarginMs('84532')).toBe(5 * 60_000);
    expect(reorgMarginMs('1')).toBe(15 * 60_000);
    expect(reorgMarginMs('560048')).toBe(15 * 60_000);
    expect(reorgMarginMs('137')).toBe(30 * 60_000);
    expect(reorgMarginMs('314159')).toBe(30 * 60_000);
  });
});
