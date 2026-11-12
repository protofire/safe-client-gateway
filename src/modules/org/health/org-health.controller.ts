import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiExcludeController, ApiOkResponse } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import {
  CacheReadiness,
  ICacheReadiness,
} from '@/domain/interfaces/cache-readiness.interface';
import { ILoggingService, LoggingService } from '@/logging/logging.interface';
import { ORG_DATA_SOURCE } from '@/modules/org/db/org-data-source';
import {
  Health,
  HealthStatus,
} from '@/modules/health/routes/entities/health.entity';

const PING_TIMEOUT_MS = 2_000;

async function withTimeout(check: () => Promise<unknown>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      check(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('timed out')),
          PING_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Readiness: Redis and the org Postgres. AMQP joins when its module lands
 * (HealthRepository cannot be reused: it requires the gateway's AMQP).
 */
@Controller({ path: 'health' })
@ApiExcludeController()
export class OrgHealthController {
  constructor(
    @Inject(CacheReadiness) private readonly cache: ICacheReadiness,
    @Inject(LoggingService) private readonly loggingService: ILoggingService,
    @InjectDataSource(ORG_DATA_SOURCE) private readonly db: DataSource,
  ) {}

  @ApiOkResponse({ type: Health })
  @Get('live')
  liveness(): Health {
    // Process-up only: a Redis outage must not make the orchestrator restart us
    return new Health(HealthStatus.OK);
  }

  @ApiOkResponse({ type: Health })
  @Get('ready')
  readiness(): Promise<Health> {
    return this.check();
  }

  private async check(): Promise<Health> {
    const results = await Promise.allSettled([
      withTimeout(() => this.cache.ping()),
      withTimeout(() => this.db.query('SELECT 1')),
    ]);
    const failed = ['cache', 'database'].filter(
      (_, i) => results[i].status === 'rejected',
    );
    if (failed.length === 0) return new Health(HealthStatus.OK);
    this.loggingService.error(`Org readiness failed: ${failed.join(', ')}`);
    throw new ServiceUnavailableException(new Health(HealthStatus.KO));
  }
}
