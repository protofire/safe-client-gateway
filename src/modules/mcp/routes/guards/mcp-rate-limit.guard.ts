import { Inject, Injectable } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';
import {
  CacheService,
  type ICacheService,
} from '@/datasources/cache/cache.service.interface';
import { LogType } from '@/domain/common/entities/log-type.entity';
import { ILoggingService, LoggingService } from '@/logging/logging.interface';
import { RateLimitGuard } from '@/routes/common/guards/rate-limit.guard';

export const MCP_IP_KEY = 'mcp.ip';
const RATE_LIMIT = { max: 60, windowSeconds: 60 };

/** 60 requests a minute per client IP; the raw IP is never logged. */
@Injectable()
export class McpRateLimitGuard extends RateLimitGuard {
  constructor(
    @Inject(CacheService) cacheService: ICacheService,
    @Inject(LoggingService) loggingService: ILoggingService,
    private readonly cls: ClsService,
  ) {
    super(cacheService, loggingService, RATE_LIMIT);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const allowed = await super.canActivate(context);
    // super rejected anything that is not an IP; tools read it for their own limits
    this.cls.set(MCP_IP_KEY, context.switchToHttp().getRequest<Request>().ip);
    return allowed;
  }

  protected logInvalidIp(req: Request): void {
    this.loggingService.warn({
      type: LogType.InvalidIp,
      method: req.method,
      route: req.route.path,
    });
  }

  protected logRateLimitHit(args: {
    req: Request;
    currentRequest: number;
  }): void {
    this.loggingService.warn({
      type: LogType.RateLimit,
      method: args.req.method,
      route: args.req.route.path,
      maxRequests: RATE_LIMIT.max,
      windowSeconds: RATE_LIMIT.windowSeconds,
      currentRequest: args.currentRequest,
    });
  }
}
