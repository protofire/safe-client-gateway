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
    try {
      await this.cache.ping();
      return new Health(HealthStatus.OK);
    } catch {
      this.loggingService.error('Cache service connection is not established');
      throw new ServiceUnavailableException(new Health(HealthStatus.KO));
    }
  }
}
