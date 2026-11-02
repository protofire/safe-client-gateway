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
 * Same contract as HealthController, but Redis only: HealthRepository
 * also requires AMQP, which cgw-mcp does not connect to.
 */
@Controller({ path: 'health' })
@ApiExcludeController()
export class McpHealthController {
  constructor(
    @Inject(CacheReadiness) private readonly cache: ICacheReadiness,
    @Inject(LoggingService) private readonly loggingService: ILoggingService,
  ) {}

  @ApiOkResponse({ type: Health })
  @Get('live')
  liveness(): Promise<Health> {
    return this.check();
  }

  @ApiOkResponse({ type: Health })
  @Get('ready')
  readiness(): Promise<Health> {
    return this.check();
  }

  private async check(): Promise<Health> {
    let timeout: NodeJS.Timeout | undefined;
    try {
      // With Redis down the client queues the ping offline and it never settles
      await Promise.race([
        this.cache.ping(),
        new Promise((_, reject) => {
          timeout = setTimeout(reject, PING_TIMEOUT_MS);
        }),
      ]);
      return new Health(HealthStatus.OK);
    } catch {
      this.loggingService.error('Cache service connection is not established');
      throw new ServiceUnavailableException(new Health(HealthStatus.KO));
    } finally {
      clearTimeout(timeout);
    }
  }
}
