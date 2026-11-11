import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { getAddress, type Address } from 'viem';
import { z } from 'zod';
import { getSafeTxHash } from '@/domain/common/utils/safe';
import { DataSourceError } from '@/domain/errors/data-source.error';
import { ActivityLog } from '@/modules/org/activity/activity-log.service';
import { RateLimiter } from '@/modules/org/common/rate-limiter';
import { OrgTransaction } from '@/modules/org/db/org-transaction';
import { lockSafe } from '@/modules/org/events/safe-snapshot';
import { conflict } from '@/modules/org/orgs/org-lock';
import type { Actor } from '@/modules/org/orgs/parse';
import {
  PermissionResolver,
  type EffectivePermissions,
} from '@/modules/org/permissions/permission.resolver';
import {
  assertRunCapacity,
  fromStoredCalls,
  lockOrgFor,
  lockRun,
  readItems,
  type PayoutRunRow,
} from '@/modules/org/payouts/payout-runs.service';
import { PayoutRunsService } from '@/modules/org/payouts/payout-runs.service';
import {
  findStray,
  knownCalls,
  firstAttemptAt,
  PayoutStatusUpdater,
  type NonceEvidence,
} from '@/modules/org/payouts/payout-status.updater';
import { verifyProposedTx } from '@/modules/org/payouts/payout-verify';
import {
  EDITABLE_STATUSES,
  type PayoutRunDetail,
  type PayoutRunStatus,
} from '@/modules/org/payouts/payout.schemas';
import type { MultisigTransaction } from '@/modules/safe/domain/entities/multisig-transaction.entity';
import type { Safe } from '@/modules/safe/domain/entities/safe.entity';
import { ISafeRepository } from '@/modules/safe/domain/safe.repository.interface';

const expectedVersion = z.number().int().min(1);
const hash = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((h) => h.toLowerCase());

export const ClaimProposalSchema = z.object({
  expectedVersion,
  nonce: z.union([
    z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    z.string().regex(/^\d{1,78}$/),
  ]),
});
export const ReportProposalSchema = z.object({
  attemptId: z.uuid(),
  /** Required on the normal path; a late report after a release has none. */
  expectedVersion: expectedVersion.optional(),
  safeTxHash: hash,
});
export type ClaimProposal = z.infer<typeof ClaimProposalSchema>;
export type ReportProposal = z.infer<typeof ReportProposalSchema>;
export type ClaimResult = { attemptId: string; version: number; nonce: string };

// abuse limits (milestone P): each claim and report reads the tx-service several times
const CLAIMS_PER_USER_PER_MINUTE = 30;
const REPORTS_PER_USER_PER_MINUTE = 30;
/** Runs of one org holding a nonce at once (one per Safe besides). */
export const MAX_PINNED_RUNS_PER_ORG = 50;

/** A claim is refused with `proposal_open` while the run holds an active proposal. */
const OPEN_STATUSES: ReadonlyArray<PayoutRunStatus> = [
  'proposing',
  'proposed',
  'verifying',
];

type AttemptRow = {
  id: string;
  status: 'open' | 'reported' | 'released';
  nonce: string;
  safe_tx_hash: string | null;
  created_by: string | null;
};

const versionConflict = (): ReturnType<typeof conflict> =>
  conflict(
    'version_conflict',
    'The run was changed meanwhile; reload and try again',
  );
const proposalClosed = (): ReturnType<typeof conflict> =>
  conflict(
    'proposal_closed',
    'This proposal attempt is no longer open; reload the run',
  );
const unavailable = (): ServiceUnavailableException =>
  new ServiceUnavailableException({
    statusCode: 503,
    code: 'tx_service_unavailable',
    message: 'The transaction service could not be read; try again',
  });

/**
 * Proposal claims, verified reports and releases of payout runs (canonical
 * lifecycle: plan "Payout run status"). Every tx-service read happens before
 * the transaction; the run row lock (then the Safe lock) re-checks it all.
 */
@Injectable()
export class PayoutProposalsService {
  constructor(
    private readonly tx: OrgTransaction,
    private readonly log: ActivityLog,
    private readonly resolver: PermissionResolver,
    private readonly runs: PayoutRunsService,
    private readonly updater: PayoutStatusUpdater,
    private readonly rateLimiter: RateLimiter,
    @Inject(ISafeRepository) private readonly safes: ISafeRepository,
  ) {}

  /**
   * Pins nonce N (the run's pin, else the Safe's recommended nonce) and opens
   * an attempt bound to the run version; the UI signs at the returned nonce.
   */
  async claim(
    orgId: string,
    runId: string,
    body: ClaimProposal,
    actor: Actor,
  ): Promise<ClaimResult> {
    await this.rateLimiter.enforce(
      `payouts:claim:user:${actor.userId}`,
      CLAIMS_PER_USER_PER_MINUTE,
      60,
    );
    let before = await this.peek(orgId, runId);
    assertClaimable(before, body.expectedVersion);
    // everything the DB alone decides, before any tx-service read or cache clear;
    // the pin itself is compared under the locks, after a used pin is settled
    await this.tx.runInOrgTx(async (em) => {
      const caller = await this.resolver.effective(orgId, actor.userId, em);
      await assertClaimSlot(em, before, null, manages(caller));
    }, orgId);
    const safeAddress = getAddress(before.safe_address);
    let nonces = await this.nonces(before.chain_id, safeAddress);
    if (
      before.pinned_nonce !== null &&
      BigInt(nonces.currentNonce) > BigInt(before.pinned_nonce)
    ) {
      // N was used: settle first (committed), then decide
      try {
        await this.updater.handle(orgId, runId);
      } catch {
        throw unavailable();
      }
      before = await this.peek(orgId, runId);
      if (before.pinned_nonce !== null) {
        throw conflict(
          'retry_later',
          `Nonce ${before.pinned_nonce} was used on-chain; the run is settled once the transaction is confirmed`,
        );
      }
      nonces = await this.nonces(before.chain_id, safeAddress);
    }
    const { queued, callOnly } = await this.queueView(
      orgId,
      before,
      nonces.currentNonce,
    );

    return this.tx.runInOrgTx(async (em) => {
      const caller = await lockOrgFor(
        this.resolver,
        em,
        orgId,
        actor.userId,
        'payouts.prepare',
      );
      const run = await lockRun(em, orgId, runId);
      await lockSafe(em, run.chain_id, run.safe_address);
      assertClaimable(run, body.expectedVersion);
      await assertLinked(em, run);
      await assertClaimSlot(em, run, body.nonce, manages(caller));
      // a settled (failed, replaced, rejected) run becomes open again
      await assertRunCapacity(em, orgId, run);
      const expected = run.pinned_nonce ?? String(nonces.recommendedNonce);
      if (BigInt(body.nonce) !== BigInt(expected)) {
        throw conflictWith('nonce_mismatch', {
          message: `The payout must be signed at nonce ${expected}`,
          expectedNonce: expected,
        });
      }
      if (
        run.pinned_nonce !== null &&
        BigInt(nonces.currentNonce) > BigInt(run.pinned_nonce)
      ) {
        throw conflict('retry_later', `Nonce ${expected} was used on-chain`);
      }
      await assertNoStray(em, run, expected, queued, callOnly);
      // the stored evaluation is the one the run is proposed with
      const evaluation = await this.runs.evaluateCalls(
        em,
        run,
        fromStoredCalls(run.calls!),
      );
      const [{ id: attemptId }]: Array<{ id: string }> = await em.query(
        `INSERT INTO payout_proposal_attempts (org_id, run_id, run_version, nonce, calls, created_by)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6) RETURNING id`,
        [
          orgId,
          run.id,
          run.version,
          expected,
          JSON.stringify(run.calls),
          actor.userId,
        ],
      );
      // UPDATE … RETURNING gives [rows, rowCount] in TypeORM's pg driver
      const [[{ version }]]: [Array<{ version: number }>, number] =
        await em.query(
          `UPDATE payout_runs
            SET status = 'proposing', pinned_nonce = $3, evaluation = $4::jsonb,
                safe_tx_hash = NULL, nonce = NULL, executed_tx_hash = NULL, review = NULL,
                verifying_since = NULL, delay_notified_at = NULL,
                version = version + 1, updated_at = now()
          WHERE org_id = $1 AND id = $2 RETURNING version`,
          [orgId, run.id, expected, JSON.stringify(evaluation)],
        );
      await em.query(
        `INSERT INTO payout_watch (run_id, org_id, chain_id, safe_address)
         VALUES ($1, $2, $3, $4) ON CONFLICT (run_id) DO NOTHING`,
        [run.id, orgId, run.chain_id, run.safe_address],
      );
      await this.event(em, run, 'payout_run.proposal_claimed', actor, {
        name: run.name,
        attemptId,
        nonce: expected,
      });
      return { attemptId, version, nonce: expected };
    }, orgId);
  }

  /**
   * The `safeTxHash` the signing flow produced, verified strictly against the
   * tx-service copy. Normal path: the open attempt of a `proposing` run at
   * `expectedVersion`. Late path: a released attempt of a draft still pinned
   * at its nonce, whose tx matches the current calls. Already executed → the
   * settlement runs in the same transaction.
   */
  async report(
    orgId: string,
    runId: string,
    body: ReportProposal,
    actor: Actor,
  ): Promise<PayoutRunDetail> {
    await this.rateLimiter.enforce(
      `payouts:report:user:${actor.userId}`,
      REPORTS_PER_USER_PER_MINUTE,
      60,
    );
    const before = await this.peek(orgId, runId);
    if (before.safe_tx_hash === body.safeTxHash)
      return this.runs.get(orgId, runId, actor.userId);
    // eligibility before any external read; re-checked under the lock
    const early = await this.tx.runInOrgTx(
      (em) => this.lockAttempt(em, before, body.attemptId),
      orgId,
    );
    if (
      assertReportable(before, early) === 'normal' &&
      body.expectedVersion !== before.version
    )
      throw versionConflict();
    const N = BigInt(before.pinned_nonce!);

    let tx: MultisigTransaction;
    let safe: Safe;
    try {
      await Promise.all([
        this.safes.clearMultisigTransaction({
          chainId: before.chain_id,
          safeTransactionHash: body.safeTxHash,
        }),
        // a cached version could predate an upgrade
        this.safes.clearSafe({
          chainId: before.chain_id,
          address: getAddress(before.safe_address),
        }),
      ]);
      [tx, safe] = await Promise.all([
        this.safes.getMultiSigTransaction({
          chainId: before.chain_id,
          safeTransactionHash: body.safeTxHash,
        }),
        // the Safe version decides the EIP-712 hash the fields are checked against
        this.safes.getSafe({
          chainId: before.chain_id,
          address: getAddress(before.safe_address),
        }),
      ]);
    } catch (error) {
      if (error instanceof DataSourceError && error.code === 404) {
        // not indexed yet (or unknown): retryable, the attempt stays open
        throw new ServiceUnavailableException({
          statusCode: 503,
          code: 'tx_not_indexed',
          message:
            'The transaction service does not list this transaction yet; try again shortly',
        });
      }
      throw unavailable();
    }
    const nonces = await this.nonces(
      before.chain_id,
      getAddress(before.safe_address),
    );
    const { queued, callOnly, since } = await this.queueView(
      orgId,
      before,
      nonces.currentNonce,
    );
    // executed already (1-of-1, retried report): settle under the same lock if the evidence can be read
    let evidence: NonceEvidence | null = null;
    if (tx.isExecuted) {
      evidence = await this.updater
        .readEvidence(before.chain_id, before.safe_address, N, since)
        .catch(() => null);
    }

    await this.tx.runInOrgTx(async (em) => {
      await lockOrgFor(
        this.resolver,
        em,
        orgId,
        actor.userId,
        'payouts.prepare',
      );
      const run = await lockRun(em, orgId, runId);
      await lockSafe(em, run.chain_id, run.safe_address);
      if (run.safe_tx_hash === body.safeTxHash) return;
      const attempt = await this.lockAttempt(em, run, body.attemptId);
      const late = assertReportable(run, attempt) === 'late';
      if (!late && body.expectedVersion !== run.version)
        throw versionConflict();
      const [taken]: Array<unknown> = await em.query(
        `SELECT 1 FROM payout_runs WHERE org_id = $1 AND safe_tx_hash = $2 AND id <> $3`,
        [orgId, body.safeTxHash, run.id],
      );
      if (taken) {
        throw conflict(
          'tx_taken',
          'This Safe transaction is already recorded for another payout run',
        );
      }
      const result =
        tx.safeTxHash.toLowerCase() !== body.safeTxHash
          ? ({ ok: false, code: 'tx_mismatch', field: 'safeTxHash' } as const)
          : verifyProposedTx(
              tx,
              {
                safeAddress: getAddress(run.safe_address),
                nonce: BigInt(run.pinned_nonce!),
                calls: fromStoredCalls(run.calls!),
              },
              callOnly,
            );
      if (!result.ok && result.field === 'nonce') {
        const atTxNonce = verifyProposedTx(
          tx,
          {
            safeAddress: getAddress(run.safe_address),
            nonce: BigInt(tx.nonce),
            calls: fromStoredCalls(run.calls!),
          },
          callOnly,
        );
        if (atTxNonce.ok) {
          throw new UnprocessableEntityException({
            statusCode: 422,
            code: 'tx_wrong_nonce',
            nonce: String(tx.nonce),
            expectedNonce: run.pinned_nonce,
            message: `This payout was signed at nonce ${tx.nonce} instead of ${run.pinned_nonce}; reject the transaction at nonce ${tx.nonce} in the Safe queue so it cannot execute`,
          });
        }
      }
      if (!result.ok) {
        // a late tx of another version is not adopted; settlement judges it if it executes
        if (late) throw proposalClosed();
        throw mismatch(result.code, result.field);
      }
      // only an owner- or delegate-signed copy, whose fields really hash to what was reported
      if (!tx.trusted) throw mismatch('tx_mismatch', 'trusted');
      if (!hashesTo(run.chain_id, safe, tx, body.safeTxHash))
        throw mismatch('tx_mismatch', 'safeTxHash');
      await assertNoStray(em, run, run.pinned_nonce!, queued, callOnly);
      const proposed = await this.updater.markProposed(
        em,
        run,
        attempt.id,
        body.safeTxHash,
        actor,
      );
      if (evidence) await this.updater.apply(em, proposed, evidence);
    }, orgId);
    return this.runs.get(orgId, runId, actor.userId);
  }

  /**
   * Closes the active attempt (`proposing`: open, `proposed`: reported) with
   * no tx-service check. The run returns to a draft still pinned at N.
   */
  async release(
    orgId: string,
    runId: string,
    attemptId: string,
    actor: Actor,
  ): Promise<PayoutRunDetail> {
    await this.tx.runInOrgTx(async (em) => {
      const caller = await lockOrgFor(
        this.resolver,
        em,
        orgId,
        actor.userId,
        'payouts.prepare',
      );
      const run = await lockRun(em, orgId, runId);
      const attempt = await this.lockAttempt(em, run, attemptId);
      const active =
        (run.status === 'proposing' && attempt.status === 'open') ||
        (run.status === 'proposed' &&
          attempt.status === 'reported' &&
          attempt.safe_tx_hash === run.safe_tx_hash);
      if (!active) throw proposalClosed();
      if (attempt.created_by !== actor.userId) {
        if (!caller.permissions.includes('payouts.manage')) {
          throw new ForbiddenException({
            statusCode: 403,
            code: 'forbidden',
            message: 'Only the claimer or an admin can release this proposal',
          });
        }
      }
      await em.query(
        `UPDATE payout_proposal_attempts
            SET status = 'released', release_reason = 'released', released_at = now(),
                released_by = $3, updated_at = now()
          WHERE org_id = $1 AND id = $2`,
        [orgId, attempt.id, actor.userId],
      );
      // the pin and the watch row stay: every later proposal of this run uses N
      await em.query(
        `UPDATE payout_runs
            SET status = 'draft', safe_tx_hash = NULL, nonce = NULL,
                version = version + 1, updated_at = now()
          WHERE org_id = $1 AND id = $2`,
        [orgId, run.id],
      );
      await this.event(em, run, 'payout_run.proposal_released', actor, {
        name: run.name,
        attemptId: attempt.id,
        nonce: attempt.nonce,
        reason: 'released',
      });
    }, orgId);
    return this.runs.get(orgId, runId, actor.userId);
  }

  /** CSV rows of the run (≤ 500, read at once) and the `export.downloaded` entry, in one transaction. */
  exportRun(
    orgId: string,
    runId: string,
    actor: Actor,
  ): Promise<Array<Record<string, string>>> {
    return this.tx.runInOrgTx(async (em) => {
      const [run]: Array<
        Pick<PayoutRunRow, 'status' | 'safe_tx_hash' | 'executed_tx_hash'>
      > = await em.query(
        `SELECT status, safe_tx_hash, executed_tx_hash FROM payout_runs
          WHERE org_id = $1 AND id = $2 FOR SHARE`,
        [orgId, runId],
      );
      if (!run) throw new NotFoundException('Payout run not found');
      const items = await readItems(em, orgId, runId);
      await this.log.record(em, {
        orgId,
        actorUserId: actor.userId,
        type: 'export.downloaded',
        targetType: 'payout_run',
        targetId: runId,
        payload: { what: 'payout_run' },
        ip: actor.ip,
        userAgent: actor.userAgent,
      });
      return items.map((i) => ({
        line: String(i.line_no),
        name: i.name ?? '',
        recipient: getAddress(i.recipient),
        token: i.token === 'native' ? 'native' : getAddress(i.token),
        symbol: i.symbol,
        amount: i.amount,
        status: run.status,
        safeTxHash: run.safe_tx_hash ?? '',
        executedTxHash: run.executed_tx_hash ?? '',
      }));
    }, orgId);
  }

  // ---- helpers ----

  /** Short read for the checks and HTTP reads before the transaction; re-checked under the lock. */
  private peek(orgId: string, runId: string): Promise<PayoutRunRow> {
    return this.tx.runInOrgTx((em) => lockRun(em, orgId, runId), orgId);
  }

  /**
   * The stray-rule view (queued from the current nonce, executed from the
   * run's first attempt). Fails closed when it cannot be read whole.
   */
  private async queueView(
    orgId: string,
    run: PayoutRunRow,
    currentNonce: number,
  ): Promise<{
    queued: Array<MultisigTransaction>;
    callOnly: ReadonlySet<string>;
    since: Date | null;
  }> {
    const since = await this.tx.runInOrgTx(
      (em) => firstAttemptAt(em, run),
      orgId,
    );
    try {
      const [view, callOnly] = await Promise.all([
        this.updater.readStrayView(
          run.chain_id,
          getAddress(run.safe_address),
          currentNonce,
          since,
        ),
        this.updater.callOnly(run.chain_id),
      ]);
      if (view.complete) return { queued: view.txs, callOnly, since };
    } catch {
      throw unavailable();
    }
    // fail closed: a copy could hide in the part not read
    throw new ServiceUnavailableException({
      statusCode: 503,
      code: 'tx_service_unavailable',
      message:
        'Too much transaction history to check this payout for copies; contact support',
    });
  }

  /** Fails closed: a Safe the tx-service does not know (counterfactual) cannot be claimed. */
  private async nonces(
    chainId: string,
    safeAddress: Address,
  ): Promise<{ currentNonce: number; recommendedNonce: number }> {
    try {
      await Promise.all([
        this.safes.clearSafe({ chainId, address: safeAddress }),
        this.safes.clearMultisigTransactions({ chainId, safeAddress }),
      ]);
      return await this.safes.getNonces({ chainId, safeAddress });
    } catch (error) {
      if (error instanceof DataSourceError && error.code === 404) {
        throw new UnprocessableEntityException({
          statusCode: 422,
          code: 'safe_not_deployed',
          message:
            'This Safe is not deployed yet; deploy it before proposing a payout',
        });
      }
      throw unavailable();
    }
  }

  private async lockAttempt(
    em: EntityManager,
    run: PayoutRunRow,
    attemptId: string,
  ): Promise<AttemptRow> {
    const [attempt]: Array<AttemptRow> = await em.query(
      `SELECT id, status, nonce::text AS nonce, safe_tx_hash, created_by
         FROM payout_proposal_attempts WHERE org_id = $1 AND run_id = $2 AND id = $3
        FOR UPDATE`,
      [run.org_id, run.id, attemptId],
    );
    if (!attempt) throw new NotFoundException('Proposal attempt not found');
    return attempt;
  }

  private event(
    em: EntityManager,
    run: PayoutRunRow,
    type: 'payout_run.proposal_claimed' | 'payout_run.proposal_released',
    actor: Actor,
    payload: Record<string, unknown>,
  ): Promise<void> {
    return this.log.record(em, {
      orgId: run.org_id,
      actorUserId: actor.userId,
      type,
      targetType: 'payout_run',
      targetId: run.id,
      payload,
      ip: actor.ip,
      userAgent: actor.userAgent,
    });
  }
}

/** 409 with extra body fields (`nonce_taken { runId, name }`, `nonce_mismatch { expectedNonce }`). */
function conflictWith(
  code: string,
  body: { message: string } & Record<string, unknown>,
): ConflictException {
  return new ConflictException({ statusCode: 409, code, ...body });
}

/**
 * Which report path the attempt is on: `normal` (open attempt of a proposing
 * run) or `late` (a released, never reported attempt of a draft still pinned
 * at its nonce, with calls). Anything else is closed.
 */
function assertReportable(
  run: PayoutRunRow,
  attempt: AttemptRow,
): 'normal' | 'late' {
  if (run.status === 'verifying') {
    throw conflict(
      'retry_later',
      'The nonce of this run was used on-chain; it is settled once the transaction is confirmed',
    );
  }
  if (run.status === 'proposing' && attempt.status === 'open') return 'normal';
  if (
    run.status === 'draft' &&
    attempt.status === 'released' &&
    attempt.safe_tx_hash === null &&
    run.pinned_nonce !== null &&
    run.pinned_nonce === attempt.nonce &&
    run.calls !== null
  )
    return 'late';
  throw proposalClosed();
}

/**
 * 409 `stray_proposal` while a queued tx at another nonce than `nonce` carries
 * the run's current calls or any attempt's calls: it could execute besides it.
 */
async function assertNoStray(
  em: EntityManager,
  run: PayoutRunRow,
  nonce: string,
  queued: ReadonlyArray<MultisigTransaction>,
  callOnly: ReadonlySet<string>,
): Promise<void> {
  const stray = findStray(
    queued,
    BigInt(nonce),
    await knownCalls(em, run),
    callOnly,
  );
  if (stray) {
    throw conflictWith('stray_proposal', {
      message: `This payout is also queued at nonce ${stray.nonce}; reject that transaction in the Safe queue before proposing it at ${nonce}`,
      nonce: String(stray.nonce),
      safeTxHash: stray.safeTxHash,
    });
  }
}

const manages = (caller: EffectivePermissions | null): boolean =>
  caller?.permissions.includes('payouts.manage') ?? false;

/**
 * DB-only claim checks, run before any tx-service read and again under the
 * locks: no other run of the org pinned on this Safe (`nonce_taken`), a
 * pinned run is claimed at its pin (`nonce_mismatch`; `nonce` null skips it),
 * and the org holds fewer than {@link MAX_PINNED_RUNS_PER_ORG} pins
 * (`pin_limit`; `payouts.manage` is exempt, so members cannot lock admins out).
 */
async function assertClaimSlot(
  em: EntityManager,
  run: PayoutRunRow,
  nonce: string | number | null,
  manage: boolean,
): Promise<void> {
  const [other]: Array<{ id: string; name: string }> = await em.query(
    `SELECT id, name FROM payout_runs
      WHERE org_id = $1 AND chain_id = $2 AND safe_address = $3
        AND pinned_nonce IS NOT NULL AND id <> $4
      LIMIT 1`,
    [run.org_id, run.chain_id, run.safe_address, run.id],
  );
  if (other) {
    throw conflictWith('nonce_taken', {
      message: `Run "${other.name}" holds a nonce on this Safe; finish or settle it first`,
      runId: other.id,
      name: other.name,
    });
  }
  if (run.pinned_nonce !== null) {
    if (nonce !== null && BigInt(nonce) !== BigInt(run.pinned_nonce)) {
      throw conflictWith('nonce_mismatch', {
        message: `The payout must be signed at nonce ${run.pinned_nonce}`,
        expectedNonce: run.pinned_nonce,
      });
    }
    return; // keeps its pin: not a new one
  }
  if (manage) return;
  const [{ pinned }]: Array<{ pinned: number }> = await em.query(
    `SELECT count(*)::int AS pinned FROM payout_runs
      WHERE org_id = $1 AND pinned_nonce IS NOT NULL`,
    [run.org_id],
  );
  if (pinned >= MAX_PINNED_RUNS_PER_ORG) {
    throw conflict(
      'pin_limit',
      `The organization has ${MAX_PINNED_RUNS_PER_ORG} payout runs holding a nonce; settle some first`,
    );
  }
}

function assertClaimable(run: PayoutRunRow, expectedVersion: number): void {
  if (run.status === 'verifying') {
    throw conflict(
      'retry_later',
      'The nonce of this run was used on-chain; it is settled once the transaction is confirmed',
    );
  }
  if (OPEN_STATUSES.includes(run.status)) {
    throw conflict(
      'proposal_open',
      'A proposal of this run is open; finish or release it first',
    );
  }
  if (!EDITABLE_STATUSES.includes(run.status)) {
    throw conflict('run_locked', 'This run cannot be proposed again');
  }
  if (run.version !== expectedVersion) throw versionConflict();
  if (run.calls === null) {
    throw conflict('run_locked', 'Build the run before proposing it');
  }
}

// linked_safes has no RLS (A3): filter by org explicitly
async function assertLinked(
  em: EntityManager,
  run: PayoutRunRow,
): Promise<void> {
  const linked: Array<unknown> = await em.query(
    `SELECT 1 FROM linked_safes WHERE org_id = $1 AND chain_id = $2 AND address = $3`,
    [run.org_id, run.chain_id, run.safe_address],
  );
  if (linked.length === 0) {
    throw conflict(
      'safe_unlinked',
      'The Safe of this run is no longer linked to the organization',
    );
  }
}

/**
 * Whether the tx's own fields give `safeTxHash` (EIP-712, Safe address and
 * version). A tx signed before an upgrade across 1.3.0 hashes under the other
 * domain (chainId added in 1.3.0), so both domain variants are accepted: each
 * binds the same fields and the Safe address.
 */
function hashesTo(
  chainId: string,
  safe: Safe,
  tx: MultisigTransaction,
  safeTxHash: string,
): boolean {
  // no Safe version known: the hash cannot be checked, so it is not accepted (fails closed)
  if (!safe.version) return false;
  // 1.2.0: domain without chainId, 1.3.0: with it (both use baseGas)
  return [safe.version, '1.2.0', '1.3.0'].some((version) => {
    try {
      return (
        getSafeTxHash({
          chainId,
          transaction: tx,
          safe: { ...safe, version },
        }).toLowerCase() === safeTxHash
      );
    } catch {
      return false;
    }
  });
}

function mismatch(
  code: 'tx_mismatch' | 'multisend_unknown',
  field: string,
): UnprocessableEntityException {
  return new UnprocessableEntityException({
    statusCode: 422,
    code,
    field,
    message:
      code === 'multisend_unknown'
        ? 'The transaction does not use a known MultiSendCallOnly contract of this chain'
        : `The proposed transaction differs from the payout run (${field}); it was not recorded`,
  });
}
