import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiExcludeController, ApiOkResponse } from '@nestjs/swagger';
import {
  CacheReadiness,
  ICacheReadiness,
} from '@/domain/interfaces/cache-readiness.interface';
import { ILoggingService, LoggingService } from '@/logging/logging.interface';
import {
  Health,
  HealthStatus,
} from '@/modules/health/routes/entities/health.entity';

const PING_TIMEOUT_MS = 2_000;

/**
 * Redis-only health. Postgres/AMQP checks join when their modules land
 * (HealthRepository cannot be reused: it requires the gateway's AMQP).
 */
@Controller({ path: 'health' })
@ApiExcludeController()
export class OrgHealthController {
  constructor(
    @Inject(CacheReadiness) private readonly cache: ICacheReadiness,
    @Inject(LoggingService) private readonly loggingService: ILoggingService,
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
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.cache.ping(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('ping timed out')),
            PING_TIMEOUT_MS,
          );
        }),
      ]);
      return new Health(HealthStatus.OK);
    } catch {
      this.loggingService.error('Cache service connection is not established');
      throw new ServiceUnavailableException(new Health(HealthStatus.KO));
    } finally {
      clearTimeout(timer);
    }
  }
}
