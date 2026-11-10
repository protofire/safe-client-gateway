import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import {
  type ILoggingService,
  LoggingService,
} from '@/logging/logging.interface';
import { Clock, type IClock } from '@/modules/org/common/clock';
import { OrgTransaction } from '@/modules/org/db/org-transaction';
import { deleteUnlinkedSnapshots } from '@/modules/org/events/safe-snapshot';

const HOUR_MS = 3600 * 1000;
const BOOT_DELAY_MS = 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const PROCESSED_EVENTS_TTL_MS = 30 * DAY_MS;
const DEAD_SESSIONS_TTL_MS = 30 * DAY_MS;
// logs are kept indefinitely (spec); only the IP is personal data to expire
const LOG_IP_TTL_MS = 90 * DAY_MS;
const BATCH = 20;

/**
 * Hourly purge of organizations deleted more than 30 days ago (amendment
 * A10), of `processed_events` dedup keys older than 30 days, of sessions
 * expired or revoked more than 30 days ago, and of IPs in the activity and
 * security logs older than 90 days (the rows stay). Every row of
 * an org references it ON DELETE CASCADE, so deleting the organization
 * deletes everything scoped to it. Also runs once shortly after boot, so
 * frequent restarts cannot starve it.
 *
 * Ruling: an in-process timer instead of a BullMQ repeatable job. Each batch
 * locks its orgs FOR UPDATE SKIP LOCKED, so several replicas running at once
 * purge disjoint orgs and a concurrent restore either waits (then finds the
 * row gone) or keeps the row from being picked; no queue or leader is needed.
 */
@Injectable()
export class PurgeProcessor implements OnApplicationBootstrap, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;
  private bootTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly tx: OrgTransaction,
    @Inject(Clock) private readonly clock: IClock,
    @Inject(LoggingService) private readonly logger: ILoggingService,
  ) {}

  onApplicationBootstrap(): void {
    const run = (): void => void this.run();
    this.bootTimer = setTimeout(run, BOOT_DELAY_MS);
    this.bootTimer.unref();
    this.timer = setInterval(run, HOUR_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearTimeout(this.bootTimer);
    clearInterval(this.timer);
  }

  /** One scheduled run; failures are logged, the next run retries. */
  async run(): Promise<void> {
    for (const [name, job] of [
      ['org purge', (): Promise<unknown> => this.purgeDue()],
      [
        'processed_events purge',
        (): Promise<unknown> => this.purgeProcessedEvents(),
      ],
      ['sessions purge', (): Promise<unknown> => this.purgeDeadSessions()],
      ['log IP purge', (): Promise<unknown> => this.clearOldLogIps()],
      [
        'orphan snapshot purge',
        (): Promise<unknown> => this.purgeOrphanSnapshots(),
      ],
    ] as const) {
      try {
        await job();
      } catch (error) {
        this.logger.error(
          `${name} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /** Deletes event dedup keys older than 30 days; returns how many. */
  async purgeProcessedEvents(): Promise<number> {
    const before = new Date(
      this.clock.now().getTime() - PROCESSED_EVENTS_TTL_MS,
    );
    return this.tx.runInOrgTx(async (em) => {
      await em.query(`SET LOCAL statement_timeout = 0`);
      // DELETE resolves to [rows, affected] in TypeORM's postgres driver
      const [, deleted]: [unknown, number] = await em.query(
        `DELETE FROM processed_events WHERE processed_at < $1`,
        [before],
      );
      return deleted;
    });
  }

  /** Sessions whose expiry or revocation is more than 30 days old. */
  async purgeDeadSessions(): Promise<number> {
    const before = new Date(this.clock.now().getTime() - DEAD_SESSIONS_TTL_MS);
    return this.tx.runInOrgTx(async (em) => {
      await em.query(`SET LOCAL statement_timeout = 0`);
      const [, deleted]: [unknown, number] = await em.query(
        `DELETE FROM sessions
         WHERE LEAST(expires_at, idle_expires_at) < $1 OR revoked_at < $1`,
        [before],
      );
      return deleted;
    });
  }

  /**
   * Nulls IPs older than 90 days in both logs; returns how many rows changed.
   * shortcut: scans the logs hourly without a created_at index; add a partial
   * index (WHERE ip_encrypted IS NOT NULL) if the logs grow to millions of rows.
   */
  async clearOldLogIps(): Promise<number> {
    const before = new Date(this.clock.now().getTime() - LOG_IP_TTL_MS);
    return this.tx.runInOrgTx(async (em) => {
      await em.query(`SET LOCAL statement_timeout = 0`);
      let changed = 0;
      for (const table of ['activity_events', 'user_security_events']) {
        const [, n]: [unknown, number] = await em.query(
          `UPDATE ${table} SET ip_encrypted = NULL
           WHERE created_at < $1 AND ip_encrypted IS NOT NULL`,
          [before],
        );
        changed += n;
      }
      return changed;
    });
  }

  /**
   * Snapshots of Safes no org links (item 8), e.g. left by an unlink whose
   * delete raced a diff; a later link starts from the current state.
   */
  async purgeOrphanSnapshots(): Promise<number> {
    return this.tx.runInOrgTx(async (em) => {
      await em.query(`SET LOCAL statement_timeout = 0`);
      const [, deleted]: [unknown, number] = await em.query(
        `DELETE FROM linked_safe_snapshots s
         WHERE NOT EXISTS (SELECT 1 FROM linked_safes l
                           WHERE l.chain_id = s.chain_id AND l.address = s.address)`,
      );
      return deleted;
    });
  }

  /** Deletes every org whose `purge_after` passed; returns the purged ids. */
  async purgeDue(): Promise<Array<string>> {
    const purged: Array<string> = [];
    for (;;) {
      const now = this.clock.now();
      const batch = await this.tx.runInOrgTx(async (em) => {
        // a cascade over a large org must not hit the pool's statement timeout
        await em.query(`SET LOCAL statement_timeout = 0`);
        const rows: Array<{ id: string }> = await em.query(
          `SELECT id FROM organizations
           WHERE status = 'deleted' AND purge_after < $1
           ORDER BY id LIMIT ${BATCH} FOR UPDATE SKIP LOCKED`,
          [now],
        );
        const ids = rows.map((r) => r.id);
        if (ids.length > 0) {
          const safes: Array<{ chainId: string; address: string }> =
            await em.query(
              `SELECT DISTINCT chain_id AS "chainId", address FROM linked_safes
               WHERE org_id = ANY($1::uuid[])`,
              [ids],
            );
          await em.query(
            `DELETE FROM organizations WHERE id = ANY($1::uuid[])`,
            [ids],
          );
          await deleteUnlinkedSnapshots(em, safes);
        }
        return ids;
      });
      purged.push(...batch);
      if (batch.length < BATCH) return purged;
    }
  }
}
