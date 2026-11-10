import { encodeFunctionData, erc20Abi, type Address } from 'viem';
import { erc20TransferBuilder } from '@/modules/safe/domain/entities/__tests__/erc20-transfer.builder';
import type { MultisigTransaction } from '@/modules/safe/domain/entities/multisig-transaction.entity';
import type { Transfer } from '@/modules/safe/domain/entities/transfer.entity';
import type { SafeCall } from '@/modules/org/common/multisend';
import {
  ALICE,
  BOB,
  CAROL,
  ROWS,
  SAFE_A,
  USDC,
  addr,
  createPayoutTestApp,
  toCalls,
  type PayoutTestApp,
  type Row,
  type User,
} from '@/modules/org/payouts/__tests__/payout-test-app';
import { toCall } from '@/modules/org/payouts/payout-calls';
import { lockRun } from '@/modules/org/payouts/payout-runs.service';

const STRANGER = addr(0x5742);
const native = (to: Address, amountRaw = 1n): SafeCall =>
  toCall({ recipient: to, token: 'native', amountRaw });
const usdcTransfer = (to: Address, amount: bigint): SafeCall => ({
  to: USDC,
  value: 0n,
  data: encodeFunctionData({
    abi: erc20Abi,
    functionName: 'transfer',
    args: [to, amount],
  }),
  operation: 0,
});
const USDC_ROWS: Array<Row> = [{ address: BOB, amount: '1000.5', token: USDC }];

describe('PayoutStatusUpdater', () => {
  let p: PayoutTestApp;
  let orgA: string;
  let orgB: string;
  let member: User;
  let adminB: User;
  let safeA: string;

  beforeAll(async () => {
    p = await createPayoutTestApp(2);
    const admin = await p.user();
    member = await p.user();
    adminB = await p.user();
    orgA = await p.createOrg([
      [admin, 'admin'],
      [member, 'member'],
    ]);
    orgB = await p.createOrg([[adminB, 'admin']]);
  });

  afterAll(async () => {
    await p?.t.close();
  });

  beforeEach(async () => {
    await p.reset();
    safeA = await p.linkSafe(orgA, SAFE_A);
  });

  type Claimed = {
    runId: string;
    attemptId: string;
    version: number;
    calls: Array<SafeCall>;
    items: Awaited<ReturnType<PayoutTestApp['detail']>>['items'];
  };

  async function claimed(
    rows: Array<Row> = ROWS,
    org = orgA,
    linked = safeA,
    who = member,
    nonce = 5,
  ): Promise<Claimed> {
    const created = await p.createRun(org, linked, who, rows);
    const b = await p.build(org, created.run.id, who);
    const res = await p
      .claim(org, b.run.id, who, { expectedVersion: b.run.version, nonce })
      .expect(201);
    return {
      runId: b.run.id,
      attemptId: res.body.attemptId,
      version: res.body.version,
      calls: toCalls(b.run.calls!),
      items: b.items,
    };
  }

  async function proposed(
    rows: Array<Row> = ROWS,
  ): Promise<Claimed & { tx: MultisigTransaction }> {
    const c = await claimed(rows);
    const tx = p.chain.propose(SAFE_A, 5, c.calls);
    await p
      .report(orgA, c.runId, member, {
        attemptId: c.attemptId,
        expectedVersion: c.version,
        safeTxHash: tx.safeTxHash,
      })
      .expect(200);
    return { ...c, tx };
  }

  const status = async (runId: string, org = orgA): Promise<unknown> =>
    (await p.runRow(org, runId)).status;

  it('marks the run executed after a successful execution with all transfers', async () => {
    const r = await proposed();
    const hash = p.chain.execute(r.tx);
    p.chain.indexTransfers(SAFE_A, hash, r.items);
    expect(await p.updater.run()).toBe(1);
    expect(await p.runRow(orgA, r.runId)).toMatchObject({
      status: 'executed',
      pinned_nonce: null,
      executed_tx_hash: hash,
      review: null,
    });
    expect(await p.watchRows()).toEqual([]);
    const [settled] = await p.events('payout_run.settled');
    expect(settled.payload).toEqual({
      name: 'March',
      status: 'executed',
      safeTxHash: r.tx.safeTxHash,
      executedTxHash: hash,
      items: 2,
    });
    // a reported attempt stays reported; nothing is released
    expect(await p.events('payout_run.proposal_released')).toEqual([]);
  });

  it('keeps the run verifying while transfers are not indexed, logs verification_delayed once 10 minutes after the reorg margin and upgrades to executed when they appear', async () => {
    const r = await proposed();
    // executed 20 min ago; chain 1 margin 15 min: 5 min past the margin
    const hash = p.chain.execute(r.tx, { ago: 20 * 60_000 });
    await p.updater.run();
    const first = await p.runRow(orgA, r.runId);
    expect(first).toMatchObject({
      status: 'verifying',
      pinned_nonce: '5',
      delay_notified_at: null,
    });
    expect(first.verifying_since).toBeInstanceOf(Date);
    await p.updater.run();
    expect(await p.events('payout_run.verification_delayed')).toEqual([]);

    // measured from the end of the reorg margin, not from verifying_since
    r.tx.executionDate = new Date(Date.now() - 26 * 60_000);
    await p.updater.run();
    await p.updater.run();
    const delayed = await p.events('payout_run.verification_delayed');
    expect(delayed).toHaveLength(1);
    expect(delayed[0].payload).toEqual({
      name: 'March',
      safeTxHash: r.tx.safeTxHash,
      executedTxHash: hash,
    });
    expect(await status(r.runId)).toBe('verifying');

    p.chain.indexTransfers(SAFE_A, hash, r.items);
    await p.updater.run();
    expect(await status(r.runId)).toBe('executed');
  });

  it('ends a single false-returning token run in needs_review only at verifying_since + 24 h', async () => {
    const r = await proposed(USDC_ROWS);
    p.chain.execute(r.tx); // succeeded, but no transfer: the token returned false
    await p.updater.run();
    await p.asOrg(orgA, (em) =>
      em.query(
        `UPDATE payout_runs SET verifying_since = now() - interval '23 hours 59 minutes' WHERE id = $1`,
        [r.runId],
      ),
    );
    await p.updater.run();
    expect(await status(r.runId)).toBe('verifying');
    await p.asOrg(orgA, (em) =>
      em.query(
        `UPDATE payout_runs SET verifying_since = now() - interval '24 hours 1 minute' WHERE id = $1`,
        [r.runId],
      ),
    );
    await p.updater.run();
    expect(await p.runRow(orgA, r.runId)).toMatchObject({
      status: 'needs_review',
      review: { reason: 'missing_transfers', lines: [1] },
      pinned_nonce: null,
    });
  });

  it('reads transfers across pages until next is null and drops records of another transactionHash', async () => {
    const r = await proposed(USDC_ROWS);
    const hash = p.chain.execute(r.tx);
    p.chain.pageSize = 2;
    // a matching-looking record of another transaction, then filler, then the real one on page 3
    const other = erc20TransferBuilder()
      .with('from', SAFE_A)
      .with('to', BOB)
      .with('tokenAddress', USDC)
      .with('value', '1000500000')
      .with('transactionHash', `0x${'99'.repeat(32)}`)
      .build() as Transfer;
    const filler = (): Transfer =>
      erc20TransferBuilder()
        .with('from', SAFE_A)
        .with('to', STRANGER)
        .with('transactionHash', `0x${'98'.repeat(32)}`)
        .build() as Transfer;
    p.chain.transfers.push(other, filler(), filler(), filler());
    await p.updater.run();
    expect(await status(r.runId)).toBe('verifying');
    p.chain.indexTransfers(SAFE_A, hash, r.items);
    await p.updater.run();
    expect(await status(r.runId)).toBe('executed');
    const calls = p.chain.repo.getTransfers.mock.calls.map(([a]) => a);
    expect(calls.at(-1)).toMatchObject({ offset: 4, transactionHash: hash });
  });

  it('returns a reorged-out verifying run to proposed and clears verifying_since', async () => {
    const r = await proposed();
    p.chain.execute(r.tx);
    await p.updater.run();
    expect(await status(r.runId)).toBe('verifying');
    // the block is gone: nonce back to 5, tx queued again
    p.chain.setNonce(SAFE_A, 5);
    Object.assign(r.tx, {
      isExecuted: false,
      isSuccessful: null,
      executionDate: null,
      transactionHash: null,
    });
    await p.updater.run();
    expect(await p.runRow(orgA, r.runId)).toMatchObject({
      status: 'proposed',
      verifying_since: null,
      delay_notified_at: null,
      pinned_nonce: '5',
    });
  });

  it('answers 409 retry_later to a claim while the consumed N is not settled', async () => {
    const c = await claimed();
    await p.release(orgA, c.runId, c.attemptId, member).expect(200);
    // the released tx executes, transfers not indexed yet
    p.chain.execute(p.chain.propose(SAFE_A, 5, c.calls));
    const { run } = await p.detail(orgA, c.runId, member);
    const res = await p
      .claim(orgA, c.runId, member, { expectedVersion: run.version, nonce: 5 })
      .expect(409);
    expect(res.body.code).toBe('retry_later');
    // the settlement attempt was kept
    expect(await p.runRow(orgA, c.runId)).toMatchObject({
      status: 'verifying',
      pinned_nonce: '5',
    });
  });

  it('lets the claimer release a proposed run whose tx is still queued, keeps the pin and does not re-adopt that tx', async () => {
    const r = await proposed();
    await p.release(orgA, r.runId, r.attemptId, member).expect(200);
    await p.updater.run();
    expect(await p.runRow(orgA, r.runId)).toMatchObject({
      status: 'draft',
      pinned_nonce: '5',
      safe_tx_hash: null,
    });
  });

  it('marks a pinned draft needs_review when an outside tx at N overlaps an earlier attempt', async () => {
    const c = await claimed();
    await p.release(orgA, c.runId, c.attemptId, member).expect(200);
    const { run } = await p.detail(orgA, c.runId, member);
    await p
      .write('patch', `${orgA}/payout-runs/${c.runId}`, member, {
        expectedVersion: run.version,
        rows: [{ address: CAROL, amount: '2', token: 'native' }],
      })
      .expect(200);
    // someone signed the first version's Alice payment on its own at N
    p.chain.execute(p.chain.propose(SAFE_A, 5, [c.calls[0]]));
    await p.updater.run();
    expect(await p.runRow(orgA, c.runId)).toMatchObject({
      status: 'needs_review',
      review: { reason: 'partial_overlap' },
      pinned_nonce: null,
    });
  });

  it('keeps the pin while the execution is younger than the reorg margin', async () => {
    const r = await proposed();
    p.chain.indexTransfers(
      SAFE_A,
      p.chain.execute(r.tx, { ago: 60_000 }),
      r.items,
    );
    await p.updater.run();
    expect(await p.runRow(orgA, r.runId)).toMatchObject({
      status: 'verifying',
      pinned_nonce: '5',
    });
  });

  it('marks the run failed when the execution was not successful', async () => {
    const r = await proposed();
    p.chain.execute(r.tx, { success: false });
    await p.updater.run();
    expect(await p.runRow(orgA, r.runId)).toMatchObject({
      status: 'failed',
      pinned_nonce: null,
    });
    // failed runs are claimable again at a fresh nonce
    const { run } = await p.detail(orgA, r.runId, member);
    await p
      .claim(orgA, r.runId, member, { expectedVersion: run.version, nonce: 6 })
      .expect(201);
  });

  it('settles executed when a tx with equal calls and another hash executed at N', async () => {
    const r = await proposed();
    const twin = p.chain.propose(SAFE_A, 5, r.calls);
    const hash = p.chain.execute(twin);
    p.chain.indexTransfers(SAFE_A, hash, r.items);
    await p.updater.run();
    expect(await p.runRow(orgA, r.runId)).toMatchObject({
      status: 'executed',
      executed_tx_hash: hash,
    });
  });

  it('marks the run replaced when an unrelated plain transfer executed at N and lets the next claim take a fresh nonce', async () => {
    const r = await proposed();
    p.chain.execute(p.chain.propose(SAFE_A, 5, [native(STRANGER)]));
    await p.updater.run();
    expect(await p.runRow(orgA, r.runId)).toMatchObject({
      status: 'replaced',
      pinned_nonce: null,
    });
    const released = await p.events('payout_run.proposal_released');
    expect(released).toEqual([]); // the attempt was reported, not open
    const { run } = await p.detail(orgA, r.runId, member);
    const res = await p
      .claim(orgA, r.runId, member, { expectedVersion: run.version, nonce: 6 })
      .expect(201);
    expect(res.body.nonce).toBe('6');
  });

  it('marks the run needs_review on a partial overlap at N', async () => {
    const r = await proposed();
    p.chain.execute(
      p.chain.propose(SAFE_A, 5, [usdcTransfer(BOB, 1n), native(STRANGER)]),
    );
    await p.updater.run();
    expect(await p.runRow(orgA, r.runId)).toMatchObject({
      status: 'needs_review',
      review: { reason: 'partial_overlap' },
    });
  });

  it('marks the run rejected when a rejection tx executed at N', async () => {
    const r = await proposed();
    p.chain.execute(
      p.chain.propose(SAFE_A, 5, [
        { to: SAFE_A, value: 0n, data: '0x', operation: 0 },
      ]),
    );
    await p.updater.run();
    expect(await status(r.runId)).toBe('rejected');
  });

  it('keeps a run proposing when the report is lost and adopts the matching tx found at N', async () => {
    const c = await claimed();
    await p.updater.run();
    expect(await status(c.runId)).toBe('proposing');
    const tx = p.chain.propose(SAFE_A, 5, c.calls);
    await p.updater.run();
    expect(await p.runRow(orgA, c.runId)).toMatchObject({
      status: 'proposed',
      safe_tx_hash: tx.safeTxHash,
      nonce: '5',
    });
    const { run } = await p.detail(orgA, c.runId, member);
    expect(run.latestAttempt).toMatchObject({
      id: c.attemptId,
      status: 'reported',
    });
  });

  it('settles a never-proposed proposing run replaced when N goes to another tx', async () => {
    const c = await claimed();
    p.chain.execute(p.chain.propose(SAFE_A, 5, [native(STRANGER)]));
    await p.updater.run();
    expect(await p.runRow(orgA, c.runId)).toMatchObject({
      status: 'replaced',
      pinned_nonce: null,
    });
    const [released] = await p.events('payout_run.proposal_released');
    expect(released.payload).toEqual({
      name: 'March',
      attemptId: c.attemptId,
      nonce: '5',
      reason: 'nonce_used',
    });
    const { run } = await p.detail(orgA, c.runId, member);
    expect(run.latestAttempt).toMatchObject({ status: 'released' });
  });

  it('N consumed by an outside tx clears the pin of a never-proposed draft', async () => {
    const c = await claimed();
    await p.release(orgA, c.runId, c.attemptId, member).expect(200);
    p.chain.execute(p.chain.propose(SAFE_A, 5, [native(STRANGER)]));
    await p.updater.run();
    expect(await p.runRow(orgA, c.runId)).toMatchObject({
      status: 'draft',
      pinned_nonce: null,
    });
    expect(await p.watchRows()).toEqual([]);
    await p
      .write('delete', `${orgA}/payout-runs/${c.runId}`, member)
      .expect(204);
  });

  it('settles a pinned draft executed when its matching tx at N executes after a release', async () => {
    const r = await proposed();
    await p.release(orgA, r.runId, r.attemptId, member).expect(200);
    p.chain.indexTransfers(SAFE_A, p.chain.execute(r.tx), r.items);
    await p.updater.run();
    expect(await p.runRow(orgA, r.runId)).toMatchObject({
      status: 'executed',
      pinned_nonce: null,
      safe_tx_hash: r.tx.safeTxHash,
    });
  });

  it('never rebuilds or re-proposes a proposing, proposed, verifying, executed or needs_review run', async () => {
    const r = await proposed();
    const tryAll = async (): Promise<Array<string>> => {
      const { run } = await p.detail(orgA, r.runId, member);
      const build = await p.write(
        'post',
        `${orgA}/payout-runs/${r.runId}/build`,
        member,
        { expectedVersion: run.version },
      );
      const claim = await p.claim(orgA, r.runId, member, {
        expectedVersion: run.version,
        nonce: 5,
      });
      return [build.body.code, claim.body.code];
    };
    expect(await tryAll()).toEqual(['run_locked', 'proposal_open']);
    const hash = p.chain.execute(r.tx);
    await p.updater.run();
    expect(await status(r.runId)).toBe('verifying');
    expect(await tryAll()).toEqual(['run_locked', 'retry_later']);
    p.chain.indexTransfers(SAFE_A, hash, r.items);
    await p.updater.run();
    expect(await status(r.runId)).toBe('executed');
    expect(await tryAll()).toEqual(['run_locked', 'run_locked']);
    await p.asOrg(orgA, (em) =>
      em.query(
        `UPDATE payout_runs SET status = 'needs_review', review = '{"reason":"undecodable"}' WHERE id = $1`,
        [r.runId],
      ),
    );
    expect(await tryAll()).toEqual(['run_locked', 'run_locked']);

    // rebuild after replaced works
    const other = await claimed(ROWS, orgA, safeA, member, 6);
    p.chain.execute(p.chain.propose(SAFE_A, 6, [native(STRANGER)]));
    await p.updater.run();
    expect(await status(other.runId)).toBe('replaced');
    const rebuilt = await p.build(orgA, other.runId, member);
    expect(rebuilt.run.status).toBe('draft');
  });

  it('serialises two concurrent builds of one run', async () => {
    const created = await p.createRun(orgA, safeA, member);
    const results = await Promise.all(
      [0, 1].map(() =>
        p.write('post', `${orgA}/payout-runs/${created.run.id}/build`, member, {
          expectedVersion: created.run.version,
        }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await p.runRow(orgA, created.run.id)).version).toBe(
      created.run.version + 1,
    );
  });

  it('updates immediately on an executed-transaction event', async () => {
    const r = await proposed();
    const hash = p.chain.execute(r.tx);
    p.chain.indexTransfers(SAFE_A, hash, r.items);
    await p.updater.onExecuted('1', SAFE_A, r.tx.safeTxHash);
    expect(await status(r.runId)).toBe('executed');
    // a Safe nobody watches: no tx-service read at all
    p.chain.repo.getNonces.mockClear();
    await p.updater.onExecuted('1', addr(0x777), r.tx.safeTxHash);
    expect(p.chain.repo.getNonces).not.toHaveBeenCalled();
  });

  it('settles a run whose Safe was unlinked', async () => {
    const r = await proposed();
    await p.t.sql.query(`DELETE FROM linked_safes WHERE id = $1`, [safeA]);
    p.chain.indexTransfers(SAFE_A, p.chain.execute(r.tx), r.items);
    await p.updater.run();
    expect(await status(r.runId)).toBe('executed');
  });

  it('settles runs of two orgs that pinned the same N with different recipients: one executed, the other replaced', async () => {
    const a = await claimed([{ address: ALICE, amount: '1', token: 'native' }]);
    const safeInB = await p.linkSafe(orgB, SAFE_A);
    const b = await claimed(
      [{ address: CAROL, amount: '1', token: 'native' }],
      orgB,
      safeInB,
      adminB,
    );
    p.chain.execute(p.chain.propose(SAFE_A, 5, a.calls));
    await p.updater.run();
    expect(await status(a.runId)).toBe('executed');
    expect(await status(b.runId, orgB)).toBe('replaced');
  });

  it('settles a tx executed at N that the tx-service lists beyond the first page', async () => {
    const r = await proposed();
    // 150 queued proposals at N fill the first pages; the executed one comes last
    for (let i = 0; i < 150; i++)
      p.chain.propose(SAFE_A, 5, [native(STRANGER, BigInt(i + 1))]);
    const twin = p.chain.propose(SAFE_A, 5, r.calls);
    p.chain.indexTransfers(SAFE_A, p.chain.execute(twin), r.items);
    await p.updater.run();
    expect(await status(r.runId)).toBe('executed');
  });

  it('moves a used nonce whose execution the tx-service does not show to verifying and to needs_review at the deadline', async () => {
    const r = await proposed();
    p.chain.setNonce(SAFE_A, 6); // N used on-chain, nothing indexed yet
    await p.updater.run();
    expect(await p.runRow(orgA, r.runId)).toMatchObject({
      status: 'verifying',
      pinned_nonce: '5',
    });
    await p.asOrg(orgA, (em) =>
      em.query(
        `UPDATE payout_runs SET verifying_since = now() - interval '24 hours 1 minute' WHERE id = $1`,
        [r.runId],
      ),
    );
    await p.updater.run();
    expect(await p.runRow(orgA, r.runId)).toMatchObject({
      status: 'needs_review',
      review: { reason: 'undecodable' },
      pinned_nonce: null,
    });
  });

  it('does not roll a verifying run back with evidence read before it entered verifying', async () => {
    const r = await proposed();
    const stale = await p.updater.readEvidence('1', SAFE_A, 5n);
    p.chain.execute(r.tx, { ago: 20 * 60_000 });
    await p.updater.run();
    expect(await status(r.runId)).toBe('verifying');
    await p.t.sql.transaction(async (em) => {
      await em.query(`SELECT set_config('app.org_id', $1, true)`, [orgA]);
      const run = await lockRun(em, orgA, r.runId);
      await p.updater.apply(em, run, stale);
    });
    expect(await status(r.runId)).toBe('verifying');
    r.tx.executionDate = new Date(Date.now() - 26 * 60_000);
    await p.updater.run();
    await p.updater.run();
    expect(await p.events('payout_run.verification_delayed')).toHaveLength(1);
  });

  it('adopts a matching queued tx for a new open attempt even if an earlier attempt released that hash', async () => {
    const r = await proposed();
    await p.release(orgA, r.runId, r.attemptId, member).expect(200);
    const rebuilt = await p.build(orgA, r.runId, member);
    await p
      .claim(orgA, r.runId, member, {
        expectedVersion: rebuilt.run.version,
        nonce: 5,
      })
      .expect(201);
    // the report of the new attempt is lost; the same tx H is still queued at N
    await p.updater.run();
    expect(await p.runRow(orgA, r.runId)).toMatchObject({
      status: 'proposed',
      safe_tx_hash: r.tx.safeTxHash,
    });
  });

  it('settles needs_review partial_overlap without writing a hash another run of the org already holds', async () => {
    const c = await claimed();
    await p.release(orgA, c.runId, c.attemptId, member).expect(200);
    const tx = p.chain.propose(SAFE_A, 5, c.calls);
    // another run of the org already records this hash
    const other = await p.createRun(orgA, safeA, member);
    await p.asOrg(orgA, (em) =>
      em.query(
        `UPDATE payout_runs SET status = 'failed', safe_tx_hash = $2 WHERE id = $1`,
        [other.run.id, tx.safeTxHash],
      ),
    );
    p.chain.indexTransfers(SAFE_A, p.chain.execute(tx), c.items);
    await p.updater.run();
    expect(await p.runRow(orgA, c.runId)).toMatchObject({
      status: 'needs_review',
      review: { reason: 'partial_overlap' },
      safe_tx_hash: null,
      pinned_nonce: null,
    });
  });

  it('returns a reorged-out never-reported proposing run to proposing', async () => {
    const c = await claimed();
    const outside = p.chain.propose(SAFE_A, 5, [native(STRANGER)]);
    p.chain.execute(outside, { ago: 60_000 });
    await p.updater.run();
    expect(await status(c.runId)).toBe('verifying');
    p.chain.setNonce(SAFE_A, 5);
    Object.assign(outside, {
      isExecuted: false,
      isSuccessful: null,
      executionDate: null,
      transactionHash: null,
    });
    await p.updater.run();
    expect(await p.runRow(orgA, c.runId)).toMatchObject({
      status: 'proposing',
      verifying_since: null,
      pinned_nonce: '5',
    });
  });

  it('answers 503 to a claim when settling the used nonce cannot read the tx-service', async () => {
    const c = await claimed();
    await p.release(orgA, c.runId, c.attemptId, member).expect(200);
    p.chain.execute(p.chain.propose(SAFE_A, 5, [native(STRANGER)]));
    p.chain.repo.getMultisigTransactions.mockRejectedValueOnce(
      new Error('down'),
    );
    const { run } = await p.detail(orgA, c.runId, member);
    const res = await p
      .claim(orgA, c.runId, member, { expectedVersion: run.version, nonce: 5 })
      .expect(503);
    expect(res.body.code).toBe('tx_service_unavailable');
  });

  it('does not adopt a matching tx at N while the run calls are also queued at another nonce, and adopts it once that is gone', async () => {
    const c = await claimed();
    const stray = p.chain.propose(SAFE_A, 6, c.calls);
    const atN = p.chain.propose(SAFE_A, 5, c.calls);
    const res = await p
      .report(orgA, c.runId, member, {
        attemptId: c.attemptId,
        expectedVersion: c.version,
        safeTxHash: atN.safeTxHash,
      })
      .expect(409);
    expect(res.body.code).toBe('stray_proposal');
    await p.updater.run();
    expect(await status(c.runId)).toBe('proposing');
    p.chain.txs = p.chain.txs.filter((t) => t !== stray);
    await p.updater.run();
    expect(await p.runRow(orgA, c.runId)).toMatchObject({
      status: 'proposed',
      safe_tx_hash: atN.safeTxHash,
    });
  });

  it('does not adopt for a pinned draft while a stray copy is queued', async () => {
    const c = await claimed();
    await p.release(orgA, c.runId, c.attemptId, member).expect(200);
    p.chain.propose(SAFE_A, 6, c.calls, { trusted: false });
    p.chain.propose(SAFE_A, 5, c.calls);
    await p.updater.run();
    expect(await p.runRow(orgA, c.runId)).toMatchObject({
      status: 'draft',
      safe_tx_hash: null,
    });
  });

  it('settles an executed run needs_review stray_proposal while its calls are still queued at a later nonce', async () => {
    const r = await proposed();
    const stray = p.chain.propose(SAFE_A, 6, r.calls, { trusted: false });
    p.chain.indexTransfers(SAFE_A, p.chain.execute(r.tx), r.items);
    await p.updater.run();
    expect(await p.runRow(orgA, r.runId)).toMatchObject({
      status: 'needs_review',
      review: {
        reason: 'stray_proposal',
        nonce: '6',
        safeTxHash: stray.safeTxHash,
      },
      pinned_nonce: null,
    });
  });

  it('keeps an executed run verifying while the queue cannot be read whole', async () => {
    const r = await proposed();
    p.chain.indexTransfers(SAFE_A, p.chain.execute(r.tx), r.items);
    p.chain.txPageSize = 1;
    for (let i = 0; i < 6; i++)
      p.chain.propose(SAFE_A, 6 + i, [native(STRANGER, BigInt(i + 1))]);
    await p.updater.run();
    expect(await p.runRow(orgA, r.runId)).toMatchObject({
      status: 'verifying',
      pinned_nonce: '5',
    });
  });

  it('returns null from run while another replica holds the lock', async () => {
    const runner = p.t.sql.createQueryRunner();
    await runner.connect();
    try {
      await runner.query(`SELECT pg_advisory_lock($1, $2)`, [0x6f7267, 3]);
      expect(await p.updater.run()).toBeNull();
    } finally {
      await runner.query(`SELECT pg_advisory_unlock($1, $2)`, [0x6f7267, 3]);
      await runner.release();
    }
  });
});
