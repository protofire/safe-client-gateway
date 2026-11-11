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
import { DataSourceError } from '@/domain/errors/data-source.error';
import { ActivityLog } from '@/modules/org/activity/activity-log.service';
import { RateLimiter } from '@/modules/org/common/rate-limiter';
import { OrgTransaction } from '@/modules/org/db/org-transaction';
import { lockSafe } from '@/modules/org/events/safe-snapshot';
import { conflict } from '@/modules/org/orgs/org-lock';
import type { Actor } from '@/modules/org/orgs/parse';
import { PermissionResolver } from '@/modules/org/permissions/permission.resolver';
import {
  assertRunCapacity,
  fromStoredCalls,
  lockOrgFor,
  lockRun,
  readItems,
  runLocked,
  type PayoutRunRow,
} from '@/modules/org/payouts/payout-runs.service';
import { PayoutRunsService } from '@/modules/org/payouts/payout-runs.service';
import {
  PayoutStatusUpdater,
  type NonceEvidence,
} from '@/modules/org/payouts/payout-status.updater';
import { verifyProposedTx } from '@/modules/org/payouts/payout-verify';
import {
  EDITABLE_STATUSES,
  type PayoutRunDetail,
  type PayoutRunStatus,
  type ResolvePayoutRun,
} from '@/modules/org/payouts/payout.schemas';
import type { MultisigTransaction } from '@/modules/safe/domain/entities/multisig-transaction.entity';
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
  // optional in the schema so a missing one is a 409 version_conflict like a stale one
  expectedVersion: expectedVersion.optional(),
  safeTxHash: hash,
});
export type ClaimProposal = z.infer<typeof ClaimProposalSchema>;
export type ReportProposal = z.infer<typeof ReportProposalSchema>;
export type ClaimResult = { attemptId: string; version: number; nonce: string };

// abuse limits (milestone P): each claim and report reads the tx-service several times
const CLAIMS_PER_USER_PER_MINUTE = 30;
const REPORTS_PER_USER_PER_MINUTE = 30;

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
const unavailable = (): ServiceUnavailableException =>
  new ServiceUnavailableException({
    statusCode: 503,
    code: 'tx_service_unavailable',
    message: 'The transaction service could not be read; try again',
  });
const usedMessage = (nonce: string): string =>
  `Nonce ${nonce} was used on-chain; the run is settled once the transaction is confirmed`;

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
    await this.tx.runInOrgTx((em) => assertClaimSlot(em, before, null), orgId);
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
      if (before.pinned_nonce !== null)
        throw runLocked(before.status, usedMessage(before.pinned_nonce));
      nonces = await this.nonces(before.chain_id, safeAddress);
    }
    // RPC before the transaction; the version check under the lock keeps the calls it saw
    const simulation = await this.runs.simulate(
      before.chain_id,
      before.safe_address,
      fromStoredCalls(before.calls!),
    );

    return this.tx.runInOrgTx(async (em) => {
      await lockOrgFor(
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
      await assertClaimSlot(em, run, body.nonce);
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
        throw runLocked(run.status, usedMessage(expected));
      }
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
            SET status = 'proposing', pinned_nonce = $3, evaluation = $4::jsonb, simulation = $5::jsonb,
                safe_tx_hash = NULL, nonce = NULL, executed_tx_hash = NULL, review = NULL,
                verifying_since = NULL, version = version + 1, updated_at = now()
          WHERE org_id = $1 AND id = $2 RETURNING version`,
          [
            orgId,
            run.id,
            expected,
            JSON.stringify(evaluation),
            simulation && JSON.stringify(simulation),
          ],
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
   * The `safeTxHash` the signing flow produced for the open attempt of a
   * `proposing` run at `expectedVersion`, verified strictly against the
   * tx-service copy. Already executed → the settlement runs in the same
   * transaction.
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
    assertReportable(before, early, body.expectedVersion);

    let tx: MultisigTransaction;
    let callOnly: ReadonlySet<string>;
    try {
      await this.safes.clearMultisigTransaction({
        chainId: before.chain_id,
        safeTransactionHash: body.safeTxHash,
      });
      [tx, callOnly] = await Promise.all([
        this.safes.getMultiSigTransaction({
          chainId: before.chain_id,
          safeTransactionHash: body.safeTxHash,
        }),
        this.updater.callOnly(before.chain_id),
      ]);
    } catch {
      // not indexed yet, or the service is down: retryable, the attempt stays open
      throw unavailable();
    }
    // executed already (1-of-1, retried report): settle under the same lock if the evidence can be read
    const evidence: NonceEvidence | null = tx.isExecuted
      ? await this.updater
          .readEvidence(
            before.chain_id,
            before.safe_address,
            BigInt(before.pinned_nonce!),
            fromStoredCalls(before.calls!),
          )
          .catch(() => null)
      : null;

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
      assertReportable(run, attempt, body.expectedVersion);
      const result =
        tx.safeTxHash.toLowerCase() !== body.safeTxHash
          ? ({ ok: false, field: 'safeTxHash' } as const)
          : verifyProposedTx(
              tx,
              {
                safeAddress: getAddress(run.safe_address),
                nonce: BigInt(run.pinned_nonce!),
                calls: fromStoredCalls(run.calls!),
              },
              callOnly,
            );
      if (!result.ok) throw mismatch(result.field, run.pinned_nonce!);
      // only an owner- or delegate-signed copy
      if (!tx.trusted) throw mismatch('trusted', run.pinned_nonce!);
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
      if (!active) throw versionConflict();
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

  /** Closes a `needs_review` run by hand after an on-chain check: final, the pin is already cleared. */
  async resolve(
    orgId: string,
    runId: string,
    body: ResolvePayoutRun,
    actor: Actor,
  ): Promise<PayoutRunDetail> {
    await this.tx.runInOrgTx(async (em) => {
      await lockOrgFor(
        this.resolver,
        em,
        orgId,
        actor.userId,
        'payouts.manage',
      );
      const run = await lockRun(em, orgId, runId);
      if (run.status !== 'needs_review')
        throw runLocked(
          run.status,
          'Only a run that needs review can be resolved',
        );
      if (run.version !== body.expectedVersion) throw versionConflict();
      const note = body.note ?? null;
      await em.query(
        `UPDATE payout_runs
            SET status = 'resolved', resolved_by = $3, resolved_at = now(), resolution_note = $4,
                version = version + 1, updated_at = now()
          WHERE org_id = $1 AND id = $2`,
        [orgId, run.id, actor.userId, note],
      );
      await this.event(em, run, 'payout_run.resolved', actor, {
        name: run.name,
        note,
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
    type:
      | 'payout_run.proposal_claimed'
      | 'payout_run.proposal_released'
      | 'payout_run.resolved',
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

/** Only the open attempt of a `proposing` run at `expectedVersion` takes a report. */
function assertReportable(
  run: PayoutRunRow,
  attempt: AttemptRow,
  expectedVersion: number | undefined,
): void {
  if (run.status === 'verifying')
    throw runLocked(run.status, usedMessage(run.pinned_nonce!));
  if (
    run.status !== 'proposing' ||
    attempt.status !== 'open' ||
    run.version !== expectedVersion
  )
    throw versionConflict();
}

/**
 * DB-only claim checks, run before any tx-service read and again under the
 * locks: no other run of the org pinned on this Safe (`nonce_taken`), and a
 * pinned run is claimed at its pin (`nonce_mismatch`; `nonce` null skips it).
 */
async function assertClaimSlot(
  em: EntityManager,
  run: PayoutRunRow,
  nonce: string | number | null,
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
  if (
    run.pinned_nonce !== null &&
    nonce !== null &&
    BigInt(nonce) !== BigInt(run.pinned_nonce)
  ) {
    throw conflictWith('nonce_mismatch', {
      message: `The payout must be signed at nonce ${run.pinned_nonce}`,
      expectedNonce: run.pinned_nonce,
    });
  }
}

const NOT_CLAIMABLE: Partial<Record<PayoutRunStatus, string>> = {
  proposing: 'A proposal of this run is open; finish or release it first',
  proposed: 'A proposal of this run is open; finish or release it first',
  verifying:
    'The nonce of this run was used on-chain; it is settled once the transaction is confirmed',
};

function assertClaimable(run: PayoutRunRow, expectedVersion: number): void {
  if (!EDITABLE_STATUSES.includes(run.status)) {
    throw runLocked(
      run.status,
      NOT_CLAIMABLE[run.status] ?? 'This run cannot be proposed again',
    );
  }
  if (run.version !== expectedVersion) throw versionConflict();
  if (run.calls === null) {
    throw runLocked(run.status, 'Build the run before proposing it');
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

/** 422 `tx_mismatch { field }`; `field: 'nonce'` carries `expectedNonce`. */
function mismatch(
  field: string,
  expectedNonce: string,
): UnprocessableEntityException {
  const messages: Record<string, string> = {
    nonce: `The transaction is not at nonce ${expectedNonce}; it was not recorded. If it carries this payout, reject it in the Safe queue so it cannot execute`,
    multisend:
      'The transaction does not use a known MultiSendCallOnly contract of this chain',
  };
  return new UnprocessableEntityException({
    statusCode: 422,
    code: 'tx_mismatch',
    field,
    ...(field === 'nonce' && { expectedNonce }),
    message:
      messages[field] ??
      `The proposed transaction differs from the payout run (${field}); it was not recorded`,
  });
}
