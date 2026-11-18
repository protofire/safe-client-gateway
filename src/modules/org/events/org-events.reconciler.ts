import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import type { Address } from 'viem';
import { ILoggingService, LoggingService } from '@/logging/logging.interface';
import { ORG_DATA_SOURCE } from '@/modules/org/db/org-data-source';
import { OrgEventsHandler } from '@/modules/org/events/org-events.handler';
import { mapLimit } from '@/modules/org/safes/map-limit';

const HOUR_MS = 3600 * 1000;
const BOOT_DELAY_MS = 60 * 1000;
// org pool max is 20 and shared with the API; each Safe holds a connection
// across its node read (per-Safe lock), so stay at 2 (item 9)
export const RECONCILE_CONCURRENCY = 2;
// two-int4 advisory key space: never collides with the per-Safe bigint locks
const RUN_LOCK = [0x6f7267, 1] as const;

/**
 * Hourly (and once shortly after boot) state diff of every linked Safe, so a
 * change whose event was lost after the consumer's retries still reaches the
 * activity log (`source: 'reconcile'`). One run at a time across replicas:
 * a replica that cannot take the run lock skips its turn.
 */
@Injectable()
export class OrgEventsReconciler
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private timer: NodeJS.Timeout | undefined;
  private bootTimer: NodeJS.Timeout | undefined;

  constructor(
    @InjectDataSource(ORG_DATA_SOURCE) private readonly db: DataSource,
    private readonly handler: OrgEventsHandler,
    @Inject(LoggingService) private readonly logger: ILoggingService,
  ) {}

  onApplicationBootstrap(): void {
    const run = (): void => {
      this.run().catch((error: unknown) =>
        this.logger.error(`org reconcile failed: ${message(error)}`),
      );
    };
    this.bootTimer = setTimeout(run, BOOT_DELAY_MS);
    this.bootTimer.unref();
    this.timer = setInterval(run, HOUR_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearTimeout(this.bootTimer);
    clearInterval(this.timer);
  }

  /** Returns the number of Safes checked, or null if another run holds the lock. */
  async run(): Promise<number | null> {
    const runner = this.db.createQueryRunner();
    await runner.connect();
    try {
      const [{ locked }]: Array<{ locked: boolean }> = await runner.query(
        `SELECT pg_try_advisory_lock($1, $2) AS locked`,
        [...RUN_LOCK],
      );
      if (!locked) return null;
      try {
        // linked_safes has no RLS on purpose (A3)
        const safes: Array<{ chainId: string; address: Address }> =
          await runner.query(
            `SELECT DISTINCT chain_id AS "chainId", address FROM linked_safes`,
          );
        await mapLimit(
          safes,
          RECONCILE_CONCURRENCY,
          async ({ chainId, address }) => {
            try {
              await this.handler.reconcile(chainId, address);
            } catch (error) {
              this.logger.warn({
                type: 'org_reconcile_safe_failed',
                chainId,
                address,
                error: message(error),
              });
            }
          },
        );
        return safes.length;
      } finally {
        await runner.query(`SELECT pg_advisory_unlock($1, $2)`, [...RUN_LOCK]);
      }
    } finally {
      await runner.release();
    }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
