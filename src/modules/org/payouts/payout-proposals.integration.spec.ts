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
import { firstAttemptAt } from '@/modules/org/payouts/payout-status.updater';
import { getSafeTxHash } from '@/domain/common/utils/safe';
import type { Safe } from '@/modules/safe/domain/entities/safe.entity';

describe('payout proposals API', () => {
  let p: PayoutTestApp;
  let orgA: string;
  let orgB: string;
  let admin: User;
  let member: User;
  let member2: User;
  let adminB: User;
  let safeA: string;

  beforeAll(async () => {
    p = await createPayoutTestApp(2);
    admin = await p.user();
    member = await p.user();
    member2 = await p.user();
    adminB = await p.user();
    orgA = await p.createOrg([
      [admin, 'admin'],
      [member, 'member'],
      [member2, 'member'],
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

  async function built(
    who: User = member,
    rows: Array<Row> = ROWS,
    org = orgA,
    linked = safeA,
  ): Promise<{ runId: string; version: number }> {
    const created = await p.createRun(org, linked, who, rows);
    const b = await p.build(org, created.run.id, who);
    return { runId: b.run.id, version: b.run.version };
  }

  async function claimed(
    who: User = member,
    rows: Array<Row> = ROWS,
    nonce = 5,
  ): Promise<{
    runId: string;
    attemptId: string;
    version: number;
    calls: ReturnType<typeof toCalls>;
  }> {
    const b = await built(who, rows);
    const res = await p
      .claim(orgA, b.runId, who, { expectedVersion: b.version, nonce })
      .expect(201);
    const d = await p.detail(orgA, b.runId, who);
    return {
      runId: b.runId,
      attemptId: res.body.attemptId,
      version: res.body.version,
      calls: toCalls(d.run.calls!),
    };
  }

  async function proposed(who: User = member): Promise<
    Awaited<ReturnType<typeof claimed>> & {
      tx: ReturnType<PayoutTestApp['chain']['propose']>;
    }
  > {
    const c = await claimed(who);
    const tx = p.chain.propose(SAFE_A, 5, c.calls);
    await p
      .report(orgA, c.runId, who, {
        attemptId: c.attemptId,
        expectedVersion: c.version,
        safeTxHash: tx.safeTxHash,
      })
      .expect(200);
    return { ...c, tx };
  }

  describe('claim', () => {
    it('claims an attempt at the recommended nonce, pins it and moves the run to proposing', async () => {
      // a queued tx at 5 makes 6 the recommended nonce
      p.chain.propose(SAFE_A, 5, [
        toCall({ recipient: CAROL, token: 'native', amountRaw: 1n }),
      ]);
      const b = await built();
      const res = await p
        .claim(orgA, b.runId, member, { expectedVersion: b.version, nonce: 6 })
        .expect(201);
      expect(res.body).toEqual({
        attemptId: expect.any(String),
        version: b.version + 1,
        nonce: '6',
        evaluation: { status: 'ok' },
      });
      const { run } = await p.detail(orgA, b.runId, member);
      expect(run).toMatchObject({
        status: 'proposing',
        version: b.version + 1,
        pinnedNonce: '6',
        evaluation: { status: 'ok' },
        latestAttempt: {
          id: res.body.attemptId,
          status: 'open',
          nonce: '6',
          createdBy: member.userId,
          releasable: true,
        },
      });
      expect(await p.watchRows()).toEqual([{ run_id: b.runId, org_id: orgA }]);
      const [claimEvent] = await p.events('payout_run.proposal_claimed');
      expect(claimEvent.payload).toEqual({
        name: 'March',
        attemptId: res.body.attemptId,
        nonce: '6',
      });
    });

    it('stores the policy evaluation computed at claim time', async () => {
      const b = await built();
      await p.asOrg(orgA, async (em) => {
        const [{ id }] = await em.query(
          `INSERT INTO policies (org_id, name) VALUES ($1, 'p') RETURNING id`,
          [orgA],
        );
        await em.query(
          `INSERT INTO policy_versions (org_id, policy_id, version, scope, rules, config_hash)
           VALUES ($1, $2, 1, '{"safes":[],"chainIds":[]}', $3::jsonb, 'h')`,
          [
            orgA,
            id,
            JSON.stringify([{ kind: 'recipients_allowlist', tag: 'allowed' }]),
          ],
        );
      });
      const res = await p
        .claim(orgA, b.runId, member, { expectedVersion: b.version, nonce: 5 })
        .expect(201);
      const row = await p.runRow(orgA, b.runId);
      expect(row.evaluation).toMatchObject({ status: 'violation' });
      // returned with the claim, so the signing step shows what was stored
      expect(res.body.evaluation).toEqual(row.evaluation);
    });

    it('answers 409 nonce_mismatch to a stale body nonce and to a re-claim of a pinned draft at another nonce', async () => {
      const b = await built();
      const stale = await p
        .claim(orgA, b.runId, member, { expectedVersion: b.version, nonce: 4 })
        .expect(409);
      expect(stale.body).toMatchObject({
        code: 'nonce_mismatch',
        expectedNonce: '5',
      });
      const ok = await p
        .claim(orgA, b.runId, member, { expectedVersion: b.version, nonce: 5 })
        .expect(201);
      await p
        .release(orgA, b.runId, ok.body.attemptId as string, member)
        .expect(200);
      // another tx queued at 5: the recommended nonce is 6, the pin stays 5
      p.chain.propose(SAFE_A, 5, [
        toCall({ recipient: CAROL, token: 'native', amountRaw: 1n }),
      ]);
      const { run } = await p.detail(orgA, b.runId, member);
      const again = await p
        .claim(orgA, b.runId, member, {
          expectedVersion: run.version,
          nonce: 6,
        })
        .expect(409);
      expect(again.body).toMatchObject({
        code: 'nonce_mismatch',
        expectedNonce: '5',
      });
    });

    it('answers 409 nonce_taken naming the other pinned run of the same org and Safe', async () => {
      const first = await claimed();
      const other = await built();
      const res = await p
        .claim(orgA, other.runId, member, {
          expectedVersion: other.version,
          nonce: 5,
        })
        .expect(409);
      expect(res.body).toMatchObject({
        code: 'nonce_taken',
        runId: first.runId,
        name: 'March',
      });
    });

    it('does not consider or disclose runs of another org', async () => {
      await claimed();
      const safeInB = await p.linkSafe(orgB, SAFE_A);
      const b = await built(adminB, ROWS, orgB, safeInB);
      const res = await p
        .claim(orgB, b.runId, adminB, { expectedVersion: b.version, nonce: 5 })
        .expect(201);
      expect(res.body.nonce).toBe('5');
    });

    it('fails closed with safe_not_deployed for a counterfactual Safe and stores nothing', async () => {
      const b = await built();
      p.chain.notDeployed.add(SAFE_A.toLowerCase());
      const res = await p
        .claim(orgA, b.runId, member, { expectedVersion: b.version, nonce: 5 })
        .expect(422);
      expect(res.body.code).toBe('safe_not_deployed');
      p.chain.notDeployed.clear();
      p.chain.failNonces = true;
      await p
        .claim(orgA, b.runId, member, { expectedVersion: b.version, nonce: 5 })
        .expect(503);
      const row = await p.runRow(orgA, b.runId);
      expect(row).toMatchObject({ status: 'draft', pinned_nonce: null });
      expect(await p.watchRows()).toEqual([]);
      expect(await p.events('payout_run.proposal_claimed')).toEqual([]);
    });

    it('answers 409 stray_proposal while the run calls are queued at another nonce', async () => {
      const b = await built();
      const { run } = await p.detail(orgA, b.runId, member);
      // signed outside the claim at 5; the recommended nonce is now 6
      const stray = p.chain.propose(SAFE_A, 5, toCalls(run.calls!));
      const res = await p
        .claim(orgA, b.runId, member, { expectedVersion: b.version, nonce: 6 })
        .expect(409);
      expect(res.body).toMatchObject({
        code: 'stray_proposal',
        nonce: '5',
        safeTxHash: stray.safeTxHash,
        executed: false,
      });
    });

    it('answers 409 stray_proposal while an earlier attempt calls are queued at another nonce', async () => {
      const c = await claimed();
      await p.release(orgA, c.runId, c.attemptId, member).expect(200);
      let { run } = await p.detail(orgA, c.runId, member);
      await p
        .write('patch', `${orgA}/payout-runs/${c.runId}`, member, {
          expectedVersion: run.version,
          rows: [{ address: CAROL, amount: '2', token: 'native' }],
        })
        .expect(200);
      ({ run } = await p.build(orgA, c.runId, member));
      const stray = p.chain.propose(SAFE_A, 6, c.calls);
      const res = await p
        .claim(orgA, c.runId, member, {
          expectedVersion: run.version,
          nonce: 5,
        })
        .expect(409);
      expect(res.body).toMatchObject({
        code: 'stray_proposal',
        nonce: '6',
        safeTxHash: stray.safeTxHash,
      });
    });

    it('answers 409 stray_proposal for an untrusted (delegate-proposed) copy of the run calls', async () => {
      const b = await built();
      const { run } = await p.detail(orgA, b.runId, member);
      const stray = p.chain.propose(SAFE_A, 5, toCalls(run.calls!), {
        trusted: false,
      });
      const res = await p
        .claim(orgA, b.runId, member, { expectedVersion: b.version, nonce: 6 })
        .expect(409);
      expect(res.body).toMatchObject({
        code: 'stray_proposal',
        safeTxHash: stray.safeTxHash,
      });
    });

    it('fails closed with 503 when the queued read hits its page cap', async () => {
      const b = await built();
      p.chain.txPageSize = 1;
      for (let i = 0; i < 6; i++)
        p.chain.propose(SAFE_A, 5 + i, [
          toCall({
            recipient: CAROL,
            token: 'native',
            amountRaw: BigInt(i + 1),
          }),
        ]);
      const res = await p
        .claim(orgA, b.runId, member, { expectedVersion: b.version, nonce: 11 })
        .expect(503);
      expect(res.body).toEqual({
        statusCode: 503,
        code: 'stray_history_too_long',
        message:
          'This Safe account has too much history since this run was first proposed to check it for copies. Check on-chain that it was not paid, then create a new run from its CSV.',
      });
    });

    it('reads executed history only from the most recent pin, so older history does not fail closed', async () => {
      const c = await claimed();
      await p.release(orgA, c.runId, c.attemptId, member).expect(200);
      // N goes to an unrelated tx that moved nothing: the draft loses its pin
      p.chain.execute(
        p.chain.propose(SAFE_A, 5, [
          toCall({ recipient: CAROL, token: 'native', amountRaw: 1n }),
        ]),
        { success: false },
      );
      await p.updater.run();
      expect(await p.runRow(orgA, c.runId)).toMatchObject({
        status: 'draft',
        pinned_nonce: null,
      });
      // more executed history, all before the attempt at 5, than one read may page through
      p.chain.txPageSize = 1;
      for (let i = 6; i < 12; i++)
        p.chain.execute(
          p.chain.propose(SAFE_A, i, [
            toCall({ recipient: CAROL, token: 'native', amountRaw: BigInt(i) }),
          ]),
        );
      const { run } = await p.detail(orgA, c.runId, member);
      await p
        .claim(orgA, c.runId, member, {
          expectedVersion: run.version,
          nonce: 12,
        })
        .expect(201);
    });

    it('answers 409 stray_proposal executed for a copy executed after the run pin was cleared', async () => {
      const c = await claimed();
      await p.release(orgA, c.runId, c.attemptId, member).expect(200);
      p.chain.execute(
        p.chain.propose(SAFE_A, 5, [
          toCall({ recipient: CAROL, token: 'native', amountRaw: 1n }),
        ]),
        { success: false },
      );
      await p.updater.run();
      expect(await p.runRow(orgA, c.runId)).toMatchObject({
        status: 'draft',
        pinned_nonce: null,
      });
      // the window stays anchored at the attempt at 5 however late the re-claim comes
      const [attempt] = await p.asOrg(orgA, (em) =>
        em.query(
          `SELECT created_at FROM payout_proposal_attempts WHERE run_id = $1`,
          [c.runId],
        ),
      );
      expect(
        await p.asOrg(orgA, (em) =>
          firstAttemptAt(em, {
            org_id: orgA,
            id: c.runId,
            pinned_nonce: null,
          }),
        ),
      ).toEqual(attempt.created_at);
      const copy = p.chain.propose(SAFE_A, 6, c.calls, { trusted: false });
      p.chain.execute(copy, { ago: 1000 });
      const { run } = await p.detail(orgA, c.runId, member);
      const res = await p
        .claim(orgA, c.runId, member, {
          expectedVersion: run.version,
          nonce: 7,
        })
        .expect(409);
      expect(res.body).toMatchObject({
        code: 'stray_proposal',
        nonce: '6',
        safeTxHash: copy.safeTxHash,
        executed: true,
      });
    });

    it('answers 409 proposal_open to a second claim from another tab', async () => {
      const c = await claimed();
      const res = await p
        .claim(orgA, c.runId, member, { expectedVersion: c.version, nonce: 5 })
        .expect(409);
      expect(res.body.code).toBe('proposal_open');
    });

    it('answers 409 run_locked to DELETE, PATCH and build of a proposing run', async () => {
      const c = await claimed();
      for (const req of [
        p.write('delete', `${orgA}/payout-runs/${c.runId}`, member),
        p.write('patch', `${orgA}/payout-runs/${c.runId}`, member, {
          expectedVersion: c.version,
          name: 'x',
        }),
        p.write('post', `${orgA}/payout-runs/${c.runId}/build`, member, {
          expectedVersion: c.version,
        }),
      ]) {
        const res = await req.expect(409);
        expect(res.body.code).toBe('run_locked');
      }
    });

    it('answers 409 run_locked to a claim of a run that was never built', async () => {
      const created = await p.createRun(orgA, safeA, member);
      const res = await p
        .claim(orgA, created.run.id, member, {
          expectedVersion: created.run.version,
          nonce: 5,
        })
        .expect(409);
      expect(res.body.code).toBe('run_locked');
    });

    it('answers 409 safe_unlinked to a claim after the Safe was unlinked', async () => {
      const b = await built();
      await p.t.sql.query(`DELETE FROM linked_safes WHERE id = $1`, [safeA]);
      const res = await p
        .claim(orgA, b.runId, member, { expectedVersion: b.version, nonce: 5 })
        .expect(409);
      expect(res.body.code).toBe('safe_unlinked');
    });

    it('release keeps the pin; rebuild proposes at the same N', async () => {
      const c = await claimed();
      await p.release(orgA, c.runId, c.attemptId, member).expect(200);
      // the Safe moved on meanwhile: recommended 6, but the run keeps 5
      p.chain.propose(SAFE_A, 5, [
        toCall({ recipient: CAROL, token: 'native', amountRaw: 1n }),
      ]);
      let { run } = await p.detail(orgA, c.runId, member);
      expect(run).toMatchObject({ status: 'draft', pinnedNonce: '5' });
      await p
        .write('patch', `${orgA}/payout-runs/${c.runId}`, member, {
          expectedVersion: run.version,
          rows: [{ address: CAROL, amount: '2', token: 'native' }],
        })
        .expect(200);
      const rebuilt = await p.build(orgA, c.runId, member);
      expect(rebuilt.run.pinnedNonce).toBe('5');
      const res = await p
        .claim(orgA, c.runId, member, {
          expectedVersion: rebuilt.run.version,
          nonce: 5,
        })
        .expect(201);
      expect(res.body.nonce).toBe('5');
      ({ run } = await p.detail(orgA, c.runId, member));
      expect(run).toMatchObject({ status: 'proposing', pinnedNonce: '5' });
    });

    it('delete of a pinned draft → 409 run_pinned', async () => {
      const c = await claimed();
      await p.release(orgA, c.runId, c.attemptId, member).expect(200);
      const res = await p
        .write('delete', `${orgA}/payout-runs/${c.runId}`, member)
        .expect(409);
      expect(res.body.code).toBe('run_pinned');
    });

    it('answers 409 version_conflict to a claim or report with a stale expectedVersion', async () => {
      const b = await built();
      const claim = await p
        .claim(orgA, b.runId, member, {
          expectedVersion: b.version - 1,
          nonce: 5,
        })
        .expect(409);
      expect(claim.body.code).toBe('version_conflict');
      const c = await p
        .claim(orgA, b.runId, member, { expectedVersion: b.version, nonce: 5 })
        .expect(201);
      const { run } = await p.detail(orgA, b.runId, member);
      const tx = p.chain.propose(SAFE_A, 5, toCalls(run.calls!));
      const report = await p
        .report(orgA, b.runId, member, {
          attemptId: c.body.attemptId,
          expectedVersion: b.version,
          safeTxHash: tx.safeTxHash,
        })
        .expect(409);
      expect(report.body.code).toBe('version_conflict');
    });
  });

  describe('report', () => {
    it('accepts the report of a verified tx and records payout_run.proposed', async () => {
      const c = await claimed();
      const tx = p.chain.propose(SAFE_A, 5, c.calls);
      const res = await p
        .report(orgA, c.runId, member, {
          attemptId: c.attemptId,
          expectedVersion: c.version,
          safeTxHash: tx.safeTxHash,
        })
        .expect(200);
      expect(res.body.run).toMatchObject({
        status: 'proposed',
        safeTxHash: tx.safeTxHash,
        nonce: '5',
        pinnedNonce: '5',
        version: c.version + 1,
        latestAttempt: {
          id: c.attemptId,
          status: 'reported',
          releasable: true,
        },
      });
      const [event] = await p.events('payout_run.proposed');
      expect(event.payload).toEqual({
        name: 'March',
        safeTxHash: tx.safeTxHash,
        nonce: '5',
      });
    });

    it('answers 422 tx_wrong_nonce to the run calls signed at another nonce, and tx_mismatch field nonce when more differs', async () => {
      const c = await claimed();
      const tx = p.chain.propose(SAFE_A, 6, c.calls);
      const res = await p
        .report(orgA, c.runId, member, {
          attemptId: c.attemptId,
          expectedVersion: c.version,
          safeTxHash: tx.safeTxHash,
        })
        .expect(422);
      expect(res.body).toMatchObject({
        code: 'tx_wrong_nonce',
        nonce: '6',
        expectedNonce: '5',
      });
      const other = p.chain.propose(SAFE_A, 6, [c.calls[0]]);
      const res2 = await p
        .report(orgA, c.runId, member, {
          attemptId: c.attemptId,
          expectedVersion: c.version,
          safeTxHash: other.safeTxHash,
        })
        .expect(422);
      expect(res2.body).toMatchObject({ code: 'tx_mismatch', field: 'nonce' });
    });

    it('refuses a report with stray_proposal while the run calls signed at another nonce are still queued', async () => {
      const c = await claimed();
      const wrong = p.chain.propose(SAFE_A, 6, c.calls);
      const first = await p
        .report(orgA, c.runId, member, {
          attemptId: c.attemptId,
          expectedVersion: c.version,
          safeTxHash: wrong.safeTxHash,
        })
        .expect(422);
      expect(first.body.code).toBe('tx_wrong_nonce');
      const right = p.chain.propose(SAFE_A, 5, c.calls);
      const second = await p
        .report(orgA, c.runId, member, {
          attemptId: c.attemptId,
          expectedVersion: c.version,
          safeTxHash: right.safeTxHash,
        })
        .expect(409);
      expect(second.body).toMatchObject({
        code: 'stray_proposal',
        nonce: '6',
        safeTxHash: wrong.safeTxHash,
      });
      // the owners rejected M: it is gone from the queue
      p.chain.txs = p.chain.txs.filter((t) => t !== wrong);
      await p
        .report(orgA, c.runId, member, {
          attemptId: c.attemptId,
          expectedVersion: c.version,
          safeTxHash: right.safeTxHash,
        })
        .expect(200);
    });

    it('answers 409 proposal_closed without any tx-service read to a released, already reported attempt reporting a tx at another nonce', async () => {
      const pr = await proposed();
      await p.release(orgA, pr.runId, pr.attemptId, member).expect(200);
      const wrong = p.chain.propose(SAFE_A, 6, pr.calls);
      p.chain.repo.getMultiSigTransaction.mockClear();
      p.chain.repo.getMultisigTransactions.mockClear();
      const res = await p
        .report(orgA, pr.runId, member, {
          attemptId: pr.attemptId,
          safeTxHash: wrong.safeTxHash,
        })
        .expect(409);
      expect(res.body.code).toBe('proposal_closed');
      expect(p.chain.repo.getMultiSigTransaction).not.toHaveBeenCalled();
      expect(p.chain.repo.getMultisigTransactions).not.toHaveBeenCalled();
    });

    it('answers 409 retry_later to a report on a verifying run', async () => {
      const c = await claimed();
      p.chain.execute(
        p.chain.propose(SAFE_A, 5, [
          toCall({ recipient: CAROL, token: 'native', amountRaw: 1n }),
        ]),
        { ago: 60_000 },
      );
      await p.updater.run();
      expect(await p.runRow(orgA, c.runId)).toMatchObject({
        status: 'verifying',
      });
      const tx = p.chain.propose(SAFE_A, 5, c.calls);
      const res = await p
        .report(orgA, c.runId, member, {
          attemptId: c.attemptId,
          expectedVersion: c.version,
          safeTxHash: tx.safeTxHash,
        })
        .expect(409);
      expect(res.body.code).toBe('retry_later');
    });

    it('answers 503 tx_not_indexed to a hash the tx-service does not know yet and keeps the attempt open', async () => {
      const c = await claimed();
      const res = await p
        .report(orgA, c.runId, member, {
          attemptId: c.attemptId,
          expectedVersion: c.version,
          safeTxHash: `0x${'7'.repeat(64)}`,
        })
        .expect(503);
      expect(res.body.code).toBe('tx_not_indexed');
      expect(await p.runRow(orgA, c.runId)).toMatchObject({
        status: 'proposing',
      });
    });

    it('answers 409 proposal_closed before any tx-service read when the run is not open for a report', async () => {
      const pr = await proposed();
      p.chain.repo.getMultiSigTransaction.mockClear();
      const other = p.chain.propose(SAFE_A, 5, pr.calls);
      const res = await p
        .report(orgA, pr.runId, member, {
          attemptId: pr.attemptId,
          expectedVersion: pr.version,
          safeTxHash: other.safeTxHash,
        })
        .expect(409);
      expect(res.body.code).toBe('proposal_closed');
      expect(p.chain.repo.getMultiSigTransaction).not.toHaveBeenCalled();
    });

    it('rejects a tampered tx with tx_mismatch and keeps the attempt open', async () => {
      const c = await claimed();
      const tampered = [...c.calls];
      tampered[0] = { ...tampered[0], to: CAROL };
      const tx = p.chain.propose(SAFE_A, 5, tampered);
      const res = await p
        .report(orgA, c.runId, member, {
          attemptId: c.attemptId,
          expectedVersion: c.version,
          safeTxHash: tx.safeTxHash,
        })
        .expect(422);
      expect(res.body).toMatchObject({
        code: 'tx_mismatch',
        field: 'calls.0.to',
      });
      const { run } = await p.detail(orgA, c.runId, member);
      expect(run).toMatchObject({
        status: 'proposing',
        latestAttempt: { id: c.attemptId, status: 'open' },
      });
    });

    it('rejects an untrusted tx with tx_mismatch field trusted', async () => {
      const c = await claimed();
      const tx = p.chain.propose(SAFE_A, 5, c.calls, { trusted: false });
      const res = await p
        .report(orgA, c.runId, member, {
          attemptId: c.attemptId,
          expectedVersion: c.version,
          safeTxHash: tx.safeTxHash,
        })
        .expect(422);
      expect(res.body).toMatchObject({ code: 'tx_mismatch', field: 'trusted' });
      expect(await p.runRow(orgA, c.runId)).toMatchObject({
        status: 'proposing',
      });
    });

    it('rejects a tx whose returned fields do not hash to the reported safeTxHash', async () => {
      const c = await claimed();
      // the tx-service copy claims a hash its fields do not produce
      const tx = p.chain.propose(SAFE_A, 5, c.calls, {
        safeTxHash: `0x${'5a'.repeat(32)}`,
      });
      const res = await p
        .report(orgA, c.runId, member, {
          attemptId: c.attemptId,
          expectedVersion: c.version,
          safeTxHash: tx.safeTxHash,
        })
        .expect(422);
      expect(res.body).toMatchObject({
        code: 'tx_mismatch',
        field: 'safeTxHash',
      });
      expect(p.chain.repo.getSafe).toHaveBeenCalledWith({
        chainId: '1',
        address: SAFE_A,
      });
    });

    it('clears the cached Safe before reading the version the hash is checked with', async () => {
      const c = await claimed();
      const tx = p.chain.propose(SAFE_A, 5, c.calls);
      p.chain.repo.clearSafe.mockClear();
      p.chain.repo.getSafe.mockClear();
      await p
        .report(orgA, c.runId, member, {
          attemptId: c.attemptId,
          expectedVersion: c.version,
          safeTxHash: tx.safeTxHash,
        })
        .expect(200);
      expect(p.chain.repo.clearSafe.mock.invocationCallOrder[0]).toBeLessThan(
        p.chain.repo.getSafe.mock.invocationCallOrder[0],
      );
    });

    it('accepts a tx signed before the Safe was upgraded across 1.3.0 (domain without chainId)', async () => {
      const c = await claimed();
      const tx = p.chain.propose(SAFE_A, 5, c.calls);
      // signed under a 1.2.0 domain; the Safe now reports 1.3.0
      tx.safeTxHash = getSafeTxHash({
        chainId: '1',
        transaction: tx,
        safe: { address: SAFE_A, version: '1.2.0' } as Safe,
      });
      await p
        .report(orgA, c.runId, member, {
          attemptId: c.attemptId,
          expectedVersion: c.version,
          safeTxHash: tx.safeTxHash,
        })
        .expect(200);
      expect(await p.runRow(orgA, c.runId)).toMatchObject({
        status: 'proposed',
        safe_tx_hash: tx.safeTxHash.toLowerCase(),
      });
    });

    it('fails closed with tx_mismatch when the Safe version is unknown', async () => {
      const c = await claimed();
      const tx = p.chain.propose(SAFE_A, 5, c.calls);
      p.chain.repo.getSafe.mockResolvedValueOnce({
        address: SAFE_A,
        version: null,
      } as Safe);
      const res = await p
        .report(orgA, c.runId, member, {
          attemptId: c.attemptId,
          expectedVersion: c.version,
          safeTxHash: tx.safeTxHash,
        })
        .expect(422);
      expect(res.body).toMatchObject({
        code: 'tx_mismatch',
        field: 'safeTxHash',
      });
    });

    it('answers 422 multisend_unknown when the outer target is not a MultiSendCallOnly', async () => {
      const c = await claimed();
      const tx = p.chain.propose(SAFE_A, 5, c.calls, { to: addr(0xbad) });
      const res = await p
        .report(orgA, c.runId, member, {
          attemptId: c.attemptId,
          expectedVersion: c.version,
          safeTxHash: tx.safeTxHash,
        })
        .expect(422);
      expect(res.body).toMatchObject({
        code: 'multisend_unknown',
        field: 'to',
      });
    });

    it('is idempotent for the same safeTxHash and 409 for a hash used by another run', async () => {
      const first = await proposed();
      // same report again: 200, nothing new
      const again = await p
        .report(orgA, first.runId, member, {
          attemptId: first.attemptId,
          expectedVersion: first.version,
          safeTxHash: first.tx.safeTxHash,
        })
        .expect(200);
      expect(again.body.run.status).toBe('proposed');
      expect(await p.events('payout_run.proposed')).toHaveLength(1);

      // the first run settles, a second run of the org reports the same hash
      p.chain.indexTransfers(
        SAFE_A,
        p.chain.execute(first.tx),
        (await p.detail(orgA, first.runId, member)).items,
      );
      await p.updater.run();
      const second = await claimed(member, ROWS, 6);
      const res = await p
        .report(orgA, second.runId, member, {
          attemptId: second.attemptId,
          expectedVersion: second.version,
          safeTxHash: first.tx.safeTxHash,
        })
        .expect(409);
      expect(res.body.code).toBe('tx_taken');
      // idempotent after settlement too
      await p
        .report(orgA, first.runId, member, {
          attemptId: first.attemptId,
          safeTxHash: first.tx.safeTxHash,
        })
        .expect(200);
    });

    it('accepts a report after execution, marks it verifying and settles it executed after the reorg margin', async () => {
      const c = await claimed();
      const tx = p.chain.propose(SAFE_A, 5, c.calls);
      const hash = p.chain.execute(tx, { ago: 60_000 });
      const { items } = await p.detail(orgA, c.runId, member);
      p.chain.indexTransfers(SAFE_A, hash, items);
      const res = await p
        .report(orgA, c.runId, member, {
          attemptId: c.attemptId,
          expectedVersion: c.version,
          safeTxHash: tx.safeTxHash,
        })
        .expect(200);
      expect(res.body.run).toMatchObject({
        status: 'verifying',
        pinnedNonce: '5',
        verifyingSince: expect.any(String),
      });
      tx.executionDate = new Date(Date.now() - 3_600_000);
      await p.updater.run();
      expect(await p.runRow(orgA, c.runId)).toMatchObject({
        status: 'executed',
        pinned_nonce: null,
        executed_tx_hash: hash,
      });
      expect(await p.watchRows()).toEqual([]);
    });

    it('settles a 1-of-1 immediate execution reported once, without a second settlement', async () => {
      const c = await claimed();
      const tx = p.chain.propose(SAFE_A, 5, c.calls);
      const hash = p.chain.execute(tx);
      p.chain.indexTransfers(
        SAFE_A,
        hash,
        (await p.detail(orgA, c.runId, member)).items,
      );
      const res = await p
        .report(orgA, c.runId, member, {
          attemptId: c.attemptId,
          expectedVersion: c.version,
          safeTxHash: tx.safeTxHash,
        })
        .expect(200);
      expect(res.body.run).toMatchObject({
        status: 'executed',
        safeTxHash: tx.safeTxHash,
        executedTxHash: hash,
        pinnedNonce: null,
      });
      await p.updater.run();
      await p.updater.onExecuted('1', SAFE_A, tx.safeTxHash);
      const settled = await p.events('payout_run.settled');
      expect(settled).toHaveLength(1);
      expect(settled[0].payload).toEqual({
        name: 'March',
        status: 'executed',
        safeTxHash: tx.safeTxHash,
        executedTxHash: hash,
        items: 2,
      });
    });

    it('lets only one of two concurrent reports with different hashes win', async () => {
      const c = await claimed();
      const a = p.chain.propose(SAFE_A, 5, c.calls);
      const b = p.chain.propose(SAFE_A, 5, c.calls);
      const results = await Promise.all(
        [a, b].map((tx) =>
          p.report(orgA, c.runId, member, {
            attemptId: c.attemptId,
            expectedVersion: c.version,
            safeTxHash: tx.safeTxHash,
          }),
        ),
      );
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(await p.events('payout_run.proposed')).toHaveLength(1);
    });

    it('adopts a late matching report at N after a release', async () => {
      const c = await claimed();
      await p.release(orgA, c.runId, c.attemptId, member).expect(200);
      // the hardware wallet finishes after the release
      const tx = p.chain.propose(SAFE_A, 5, c.calls);
      const res = await p
        .report(orgA, c.runId, member, {
          attemptId: c.attemptId,
          safeTxHash: tx.safeTxHash,
        })
        .expect(200);
      expect(res.body.run).toMatchObject({
        status: 'proposed',
        safeTxHash: tx.safeTxHash,
        latestAttempt: { id: c.attemptId, status: 'reported' },
      });
    });

    it('does not adopt a late report of an older version after an edit, and settles it needs_review if it executes', async () => {
      const c = await claimed();
      await p.release(orgA, c.runId, c.attemptId, member).expect(200);
      const { run } = await p.detail(orgA, c.runId, member);
      await p
        .write('patch', `${orgA}/payout-runs/${c.runId}`, member, {
          expectedVersion: run.version,
          rows: [{ address: CAROL, amount: '2', token: 'native' }],
        })
        .expect(200);
      await p.build(orgA, c.runId, member);
      const old = p.chain.propose(SAFE_A, 5, c.calls);
      const res = await p
        .report(orgA, c.runId, member, {
          attemptId: c.attemptId,
          safeTxHash: old.safeTxHash,
        })
        .expect(409);
      expect(res.body.code).toBe('proposal_closed');
      expect(await p.runRow(orgA, c.runId)).toMatchObject({
        status: 'draft',
        pinned_nonce: '5',
      });

      p.chain.execute(old);
      await p.updater.run();
      expect(await p.runRow(orgA, c.runId)).toMatchObject({
        status: 'needs_review',
        review: { reason: 'partial_overlap' },
        pinned_nonce: null,
      });
    });
  });

  describe('release', () => {
    it('lets the claimer release with no tx-service check and keeps the pin and watch row', async () => {
      const c = await claimed();
      p.chain.repo.getMultisigTransactions.mockClear();
      p.chain.repo.getNonces.mockClear();
      const res = await p
        .release(orgA, c.runId, c.attemptId, member)
        .expect(200);
      expect(p.chain.repo.getMultisigTransactions).not.toHaveBeenCalled();
      expect(p.chain.repo.getNonces).not.toHaveBeenCalled();
      expect(res.body.run).toMatchObject({
        status: 'draft',
        pinnedNonce: '5',
        version: c.version + 1,
        latestAttempt: {
          id: c.attemptId,
          status: 'released',
          releasable: false,
        },
      });
      expect(await p.watchRows()).toEqual([{ run_id: c.runId, org_id: orgA }]);
      const [event] = await p.events('payout_run.proposal_released');
      expect(event.payload).toEqual({
        name: 'March',
        attemptId: c.attemptId,
        nonce: '5',
        reason: 'released',
      });
    });

    it('lets an admin release another member attempt and refuses a member', async () => {
      const c = await claimed(member);
      const refused = await p
        .release(orgA, c.runId, c.attemptId, member2)
        .expect(403);
      expect(refused.body.statusCode).toBe(403);
      await p.release(orgA, c.runId, c.attemptId, admin).expect(200);
      // a released attempt cannot be released again
      const again = await p
        .release(orgA, c.runId, c.attemptId, admin)
        .expect(409);
      expect(again.body.code).toBe('proposal_closed');
    });

    it('releases a proposed run and clears its reported hash', async () => {
      const pr = await proposed();
      const res = await p
        .release(orgA, pr.runId, pr.attemptId, member)
        .expect(200);
      expect(res.body.run).toMatchObject({
        status: 'draft',
        safeTxHash: null,
        nonce: null,
        pinnedNonce: '5',
      });
    });

    it('blocks other runs of the org on the Safe with nonce_taken while a released draft is still pinned', async () => {
      const c = await claimed();
      await p.release(orgA, c.runId, c.attemptId, member).expect(200);
      const other = await built();
      const res = await p
        .claim(orgA, other.runId, member, {
          expectedVersion: other.version,
          nonce: 5,
        })
        .expect(409);
      expect(res.body).toMatchObject({ code: 'nonce_taken', runId: c.runId });
    });

    it('returns latestAttempt releasable for proposing and proposed runs to the claimer and payouts.manage only', async () => {
      const c = await claimed(member);
      const as = async (who: User): Promise<boolean> =>
        (await p.detail(orgA, c.runId, who)).run.latestAttempt!.releasable;
      expect([await as(member), await as(admin), await as(member2)]).toEqual([
        true,
        true,
        false,
      ]);
      const tx = p.chain.propose(SAFE_A, 5, c.calls);
      await p
        .report(orgA, c.runId, member, {
          attemptId: c.attemptId,
          expectedVersion: c.version,
          safeTxHash: tx.safeTxHash,
        })
        .expect(200);
      expect([await as(member), await as(admin), await as(member2)]).toEqual([
        true,
        true,
        false,
      ]);
    });
  });

  describe('export', () => {
    it('exports the run with statuses and guards formula cells', async () => {
      const pr = await proposed();
      await p.asOrg(orgA, (em) =>
        em.query(
          `UPDATE payout_items SET name = '=HYPERLINK("x")' WHERE line_no = 1`,
        ),
      );
      const res = await p
        .get(`${orgA}/payout-runs/${pr.runId}/export.csv`, member)
        .expect(200);
      expect(res.headers['content-type']).toContain('text/csv');
      const lines = res.text.trim().split('\n');
      expect(lines[0]).toBe(
        'line,name,recipient,token,symbol,amount,status,safeTxHash,executedTxHash',
      );
      expect(lines[1]).toBe(
        `1,"'=HYPERLINK(""x"")",${ALICE},native,ETH,1.5,proposed,${pr.tx.safeTxHash},`,
      );
      expect(lines[2]).toBe(
        `2,,${BOB},${USDC},USDC,1000.5,proposed,${pr.tx.safeTxHash},`,
      );
      const [event] = await p.events('export.downloaded');
      expect(event.payload).toMatchObject({ what: 'payout_run' });
    });

    it('answers 429 when the export budget is spent', async () => {
      const b = await built();
      for (let i = 0; i < 20; i++) {
        await p
          .get(`${orgA}/payout-runs/${b.runId}/export.csv`, member2)
          .expect(200);
      }
      await p
        .get(`${orgA}/payout-runs/${b.runId}/export.csv`, member2)
        .expect(429);
    });

    it('answers 404 for the export of another org run', async () => {
      const b = await built();
      await p
        .get(`${orgB}/payout-runs/${b.runId}/export.csv`, adminB)
        .expect(404);
    });
  });

  describe('abuse limits', () => {
    const limitKey = (name: string): string =>
      `${p.t.prefix}ratelimit:payouts:${name}`;

    it('rate-limits run creation per user (60/h) and per org (300/h)', async () => {
      await p.t.redis.set(limitKey(`create:user:${member.userId}`), '60');
      await p
        .write('post', `${orgA}/payout-runs`, member, {
          linkedSafeId: safeA,
          name: 'x',
          rows: ROWS,
        })
        .expect(429);
      // another user of the org is not affected by member's budget
      await p.createRun(orgA, safeA, member2);
      await p.t.redis.set(limitKey(`create:org:${orgA}`), '300');
      await p
        .write('post', `${orgA}/payout-runs`, admin, {
          linkedSafeId: safeA,
          name: 'x',
          rows: ROWS,
        })
        .expect(429);
    });

    it('rate-limits claims and reports per user (30/min) before any tx-service read', async () => {
      const b = await built();
      await p.t.redis.set(limitKey(`claim:user:${member.userId}`), '30');
      p.chain.repo.getNonces.mockClear();
      await p
        .claim(orgA, b.runId, member, { expectedVersion: b.version, nonce: 5 })
        .expect(429);
      expect(p.chain.repo.getNonces).not.toHaveBeenCalled();

      const c = await claimed(member2);
      const tx = p.chain.propose(SAFE_A, 5, c.calls);
      await p.t.redis.set(limitKey(`report:user:${member2.userId}`), '30');
      p.chain.repo.getMultiSigTransaction.mockClear();
      await p
        .report(orgA, c.runId, member2, {
          attemptId: c.attemptId,
          expectedVersion: c.version,
          safeTxHash: tx.safeTxHash,
        })
        .expect(429);
      expect(p.chain.repo.getMultiSigTransaction).not.toHaveBeenCalled();
    });

    it('checks another pinned run from the DB before any tx-service read', async () => {
      const c = await claimed();
      await p.release(orgA, c.runId, c.attemptId, member).expect(200);
      p.chain.repo.getNonces.mockClear();
      p.chain.repo.clearSafe.mockClear();
      const other = await built();
      const taken = await p
        .claim(orgA, other.runId, member, {
          expectedVersion: other.version,
          nonce: 6,
        })
        .expect(409);
      expect(taken.body).toMatchObject({ code: 'nonce_taken', runId: c.runId });
      expect(p.chain.repo.getNonces).not.toHaveBeenCalled();
      expect(p.chain.repo.clearSafe).not.toHaveBeenCalled();
    });

    it('answers nonce_mismatch to a pinned re-claim at another nonce while the pin is unused', async () => {
      const c = await claimed();
      await p.release(orgA, c.runId, c.attemptId, member).expect(200);
      const { run } = await p.detail(orgA, c.runId, member);
      const wrong = await p
        .claim(orgA, c.runId, member, {
          expectedVersion: run.version,
          nonce: 6,
        })
        .expect(409);
      expect(wrong.body).toMatchObject({
        code: 'nonce_mismatch',
        expectedNonce: '5',
      });
    });

    it('settles a used pin first instead of answering nonce_mismatch to a claim at the next nonce', async () => {
      const c = await claimed();
      await p.release(orgA, c.runId, c.attemptId, member).expect(200);
      const { run } = await p.detail(orgA, c.runId, member);
      // N goes to an unrelated tx: the draft only loses its pin
      p.chain.execute(
        p.chain.propose(SAFE_A, 5, [
          toCall({ recipient: CAROL, token: 'native', amountRaw: 1n }),
        ]),
        { success: false },
      );
      const res = await p
        .claim(orgA, c.runId, member, {
          expectedVersion: run.version,
          nonce: 6,
        })
        .expect(409);
      // settled meanwhile: the version moved, the claim is retried on the fresh run
      expect(res.body.code).toBe('version_conflict');
      expect(await p.runRow(orgA, c.runId)).toMatchObject({
        status: 'draft',
        pinned_nonce: null,
      });
      const fresh = await p.detail(orgA, c.runId, member);
      const ok = await p
        .claim(orgA, c.runId, member, {
          expectedVersion: fresh.run.version,
          nonce: 6,
        })
        .expect(201);
      expect(ok.body.nonce).toBe('6');
    });

    it('answers 409 run_limit at 500 outstanding runs of the org', async () => {
      await p.asOrg(orgA, (em) =>
        em.query(
          `INSERT INTO payout_runs (org_id, chain_id, safe_address, name)
           SELECT $1, '1', $2, 'r' || g FROM generate_series(1, 500) g`,
          [orgA, SAFE_A.toLowerCase()],
        ),
      );
      const res = await p
        .write('post', `${orgA}/payout-runs`, member, {
          linkedSafeId: safeA,
          name: 'x',
          rows: ROWS,
        })
        .expect(409);
      expect(res.body.code).toBe('run_limit');
      // settled runs do not count
      await p.asOrg(orgA, (em) =>
        em.query(
          `UPDATE payout_runs SET status = 'executed' WHERE name = 'r1'`,
        ),
      );
      await p.createRun(orgA, safeA, member);
    });

    it('answers 409 pin_limit at 50 pinned runs of the org', async () => {
      await p.asOrg(orgA, (em) =>
        em.query(
          `INSERT INTO payout_runs (org_id, chain_id, safe_address, name, status, pinned_nonce)
           SELECT $1, '1', '0x' || lpad(to_hex(4096 + g), 40, '0'), 'r' || g, 'proposing', 1
             FROM generate_series(1, 50) g`,
          [orgA],
        ),
      );
      const b = await built();
      const res = await p
        .claim(orgA, b.runId, member, { expectedVersion: b.version, nonce: 5 })
        .expect(409);
      expect(res.body.code).toBe('pin_limit');
    });

    it('lets payouts.manage claim past pin_limit', async () => {
      await p.asOrg(orgA, (em) =>
        em.query(
          `INSERT INTO payout_runs (org_id, chain_id, safe_address, name, status, pinned_nonce)
           SELECT $1, '1', '0x' || lpad(to_hex(4096 + g), 40, '0'), 'r' || g, 'proposing', 1
             FROM generate_series(1, 50) g`,
          [orgA],
        ),
      );
      const b = await built(admin);
      await p
        .claim(orgA, b.runId, admin, { expectedVersion: b.version, nonce: 5 })
        .expect(201);
    });

    describe('run_limit on reopening a settled run', () => {
      const fill = (): Promise<unknown> =>
        p.asOrg(orgA, (em) =>
          em.query(
            `INSERT INTO payout_runs (org_id, chain_id, safe_address, name)
             SELECT $1, '1', $2, 'r' || g FROM generate_series(1, 499) g`,
            [orgA, SAFE_A.toLowerCase()],
          ),
        );
      const settle = async (runId: string): Promise<number> => {
        await p.asOrg(orgA, (em) =>
          em.query(`UPDATE payout_runs SET status = 'failed' WHERE id = $1`, [
            runId,
          ]),
        );
        return (await p.detail(orgA, runId, member)).run.version;
      };

      it('answers 409 run_limit to PATCH, build and claim of a failed run at 500 open runs', async () => {
        const b = await built();
        const version = await settle(b.runId);
        // 499 + the other open run below = 500 open besides the failed one
        await fill();
        await p.createRun(orgA, safeA, member);
        const patch = await p
          .write('patch', `${orgA}/payout-runs/${b.runId}`, member, {
            expectedVersion: version,
            name: 'renamed',
          })
          .expect(409);
        expect(patch.body.code).toBe('run_limit');
        const build = await p
          .write('post', `${orgA}/payout-runs/${b.runId}/build`, member, {
            expectedVersion: version,
          })
          .expect(409);
        expect(build.body.code).toBe('run_limit');
        const claim = await p
          .claim(orgA, b.runId, member, { expectedVersion: version, nonce: 5 })
          .expect(409);
        expect(claim.body.code).toBe('run_limit');
        expect(await p.runRow(orgA, b.runId)).toMatchObject({
          status: 'failed',
          version,
        });
      });

      it('lets an open pinned draft be edited, built and re-claimed at 500 open runs', async () => {
        const c = await claimed();
        await p.release(orgA, c.runId, c.attemptId, member).expect(200);
        await fill();
        const { run } = await p.detail(orgA, c.runId, member);
        const patched = await p
          .write('patch', `${orgA}/payout-runs/${c.runId}`, member, {
            expectedVersion: run.version,
            name: 'renamed',
          })
          .expect(200);
        const rebuilt = await p
          .write('post', `${orgA}/payout-runs/${c.runId}/build`, member, {
            expectedVersion: patched.body.run.version,
          })
          .expect(200);
        await p
          .claim(orgA, c.runId, member, {
            expectedVersion: rebuilt.body.run.version,
            nonce: 5,
          })
          .expect(201);
      });
    });

    describe('idle pinned draft back-off', () => {
      const idleMap = (): Map<string, number> =>
        (p.updater as unknown as { idlePolledAt: Map<string, number> })
          .idlePolledAt;

      /** Claimed, reported, released: nothing of ours left to adopt at N. */
      async function idleDraft(): Promise<string> {
        const c = await claimed();
        const tx = p.chain.propose(SAFE_A, 5, c.calls);
        await p
          .report(orgA, c.runId, member, {
            attemptId: c.attemptId,
            expectedVersion: c.version,
            safeTxHash: tx.safeTxHash,
          })
          .expect(200);
        await p.release(orgA, c.runId, c.attemptId, member).expect(200);
        return c.runId;
      }

      it('polls a pinned draft with no adoptable attempt at most every 30 minutes', async () => {
        await idleDraft();
        p.chain.repo.getNonces.mockClear();
        await p.updater.run();
        await p.updater.run();
        expect(p.chain.repo.getNonces).toHaveBeenCalledTimes(1);
        p.t.setOffset(31 * 60_000);
        await p.updater.run();
        expect(p.chain.repo.getNonces).toHaveBeenCalledTimes(2);
        // an executed-transaction event is never backed off
        await p.updater.onExecuted('1', SAFE_A, `0x${'1'.repeat(64)}`);
        expect(p.chain.repo.getNonces).toHaveBeenCalledTimes(3);
      });

      it('keeps the normal cadence for a released, never reported attempt at N', async () => {
        const c = await claimed();
        await p.release(orgA, c.runId, c.attemptId, member).expect(200);
        p.chain.repo.getNonces.mockClear();
        await p.updater.run();
        await p.updater.run();
        expect(p.chain.repo.getNonces).toHaveBeenCalledTimes(2);
      });

      it('starts the back-off only after a successful read', async () => {
        await idleDraft();
        p.chain.failNonces = true;
        await p.updater.run();
        p.chain.failNonces = false;
        p.chain.repo.getNonces.mockClear();
        await p.updater.run();
        expect(p.chain.repo.getNonces).toHaveBeenCalledTimes(1);
      });

      it('forgets the run once its pin is used', async () => {
        const runId = await idleDraft();
        await p.updater.run();
        expect(idleMap().has(runId)).toBe(true);
        p.chain.execute(
          p.chain.propose(SAFE_A, 5, [
            toCall({ recipient: CAROL, token: 'native', amountRaw: 1n }),
          ]),
          { success: false },
        );
        await p.updater.onExecuted('1', SAFE_A, `0x${'1'.repeat(64)}`);
        expect(await p.runRow(orgA, runId)).toMatchObject({
          pinned_nonce: null,
        });
        expect(idleMap().has(runId)).toBe(false);
      });
    });
  });

  describe('stale authorization', () => {
    const revoke = (who: User): Promise<unknown> =>
      p.asOrg(orgA, (em) =>
        em.query(
          `DELETE FROM role_bindings WHERE member_id IN
             (SELECT id FROM members WHERE org_id = $1 AND user_id = $2)`,
          [orgA, who.userId],
        ),
      );

    afterEach(() =>
      p.asOrg(orgA, (em) =>
        em.query(
          `INSERT INTO role_bindings (member_id, role_id, scope)
           SELECT m.id, r.id, 'org' FROM members m, roles r
            WHERE m.org_id = $1 AND m.user_id = $2 AND r.org_id IS NULL AND r.key = 'member'
              AND NOT EXISTS (SELECT 1 FROM role_bindings b WHERE b.member_id = m.id)`,
          [orgA, member.userId],
        ),
      ),
    );

    it('re-checks the permission after the tx-service reads of a claim and stores nothing', async () => {
      const b = await built();
      p.chain.repo.getNonces.mockImplementationOnce(async () => {
        await revoke(member);
        return { currentNonce: 5, recommendedNonce: 5 };
      });
      await p
        .claim(orgA, b.runId, member, { expectedVersion: b.version, nonce: 5 })
        .expect(403);
      expect(await p.runRow(orgA, b.runId)).toMatchObject({
        status: 'draft',
        pinned_nonce: null,
      });
    });

    it('re-checks the permission after the tx-service reads of a report', async () => {
      const c = await claimed();
      const tx = p.chain.propose(SAFE_A, 5, c.calls);
      p.chain.repo.getSafe.mockImplementationOnce(async () => {
        await revoke(member);
        return { address: SAFE_A, version: '1.3.0' } as never;
      });
      await p
        .report(orgA, c.runId, member, {
          attemptId: c.attemptId,
          expectedVersion: c.version,
          safeTxHash: tx.safeTxHash,
        })
        .expect(403);
      expect(await p.runRow(orgA, c.runId)).toMatchObject({
        status: 'proposing',
        safe_tx_hash: null,
      });
    });

    it('re-checks the permission after the token reads of a PATCH', async () => {
      const b = await built();
      p.chainsRepo.getChain.mockImplementationOnce(async () => {
        await revoke(member);
        return {
          chainId: '1',
          nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
          contractAddresses: {
            multiSendAddress: null,
            multiSendCallOnlyAddress: null,
          },
        };
      });
      await p
        .write('patch', `${orgA}/payout-runs/${b.runId}`, member, {
          expectedVersion: b.version,
          rows: [{ address: CAROL, amount: '1', token: 'native' }],
        })
        .expect(403);
      expect(await p.runRow(orgA, b.runId)).toMatchObject({
        version: b.version,
      });
    });

    it('requires payouts.manage to delete a run that has a proposal attempt', async () => {
      const c = await claimed();
      await p.release(orgA, c.runId, c.attemptId, member).expect(200);
      // N goes to an unrelated tx: the draft loses its pin, the attempt stays
      p.chain.execute(
        p.chain.propose(SAFE_A, 5, [
          toCall({ recipient: CAROL, token: 'native', amountRaw: 1n }),
        ]),
        { success: false },
      );
      await p.updater.run();
      expect(await p.runRow(orgA, c.runId)).toMatchObject({
        status: 'draft',
        pinned_nonce: null,
      });
      const res = await p
        .write('delete', `${orgA}/payout-runs/${c.runId}`, member)
        .expect(403);
      expect(res.body.code).toBe('forbidden');
      await p
        .write('delete', `${orgA}/payout-runs/${c.runId}`, admin)
        .expect(204);
      // without attempts a member may still delete a draft
      const b = await built();
      await p
        .write('delete', `${orgA}/payout-runs/${b.runId}`, member)
        .expect(204);
    });
  });
});
