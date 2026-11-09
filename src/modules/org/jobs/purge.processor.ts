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

const HOUR_MS = 3600 * 1000;
const BATCH = 20;

/**
 * Hourly purge of organizations deleted more than 30 days ago (amendment
 * A10). Every row of an org references it ON DELETE CASCADE, so deleting the
 * organization deletes everything scoped to it.
 *
 * Ruling: an in-process timer instead of a BullMQ repeatable job. Each batch
 * locks its orgs FOR UPDATE SKIP LOCKED, so several replicas running at once
 * purge disjoint orgs and a concurrent restore either waits (then finds the
 * row gone) or keeps the row from being picked; no queue or leader is needed.
 */
@Injectable()
export class PurgeProcessor implements OnApplicationBootstrap, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly tx: OrgTransaction,
    @Inject(Clock) private readonly clock: IClock,
    @Inject(LoggingService) private readonly logger: ILoggingService,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => {
      this.purgeDue().catch((error: unknown) =>
        this.logger.error(
          `org purge failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }, HOUR_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  /** Deletes every org whose `purge_after` passed; returns the purged ids. */
  async purgeDue(): Promise<Array<string>> {
    const purged: Array<string> = [];
    for (;;) {
      const now = this.clock.now();
      const batch = await this.tx.runInOrgTx(async (em) => {
        const rows: Array<{ id: string }> = await em.query(
          `SELECT id FROM organizations
           WHERE status = 'deleted' AND purge_after < $1
           ORDER BY id LIMIT ${BATCH} FOR UPDATE SKIP LOCKED`,
          [now],
        );
        const ids = rows.map((r) => r.id);
        if (ids.length > 0) {
          await em.query(
            `DELETE FROM organizations WHERE id = ANY($1::uuid[])`,
            [ids],
          );
        }
        return ids;
      });
      purged.push(...batch);
      if (batch.length < BATCH) return purged;
    }
  }
}
