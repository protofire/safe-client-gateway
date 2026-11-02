import { Inject, Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import {
  CacheService,
  type ICacheService,
} from '@/datasources/cache/cache.service.interface';
import { MCP_IP_KEY } from '@/modules/mcp/routes/guards/mcp-rate-limit.guard';
import { McpToolError } from '@/modules/mcp/tools/define-tool';

const MAX_FANOUT_CALLS = 5;
const WINDOW_SECONDS = 60;

/** Calls that fan out to every chain are 5 a minute per client IP. */
@Injectable()
export class McpFanoutLimit {
  constructor(
    @Inject(CacheService) private readonly cacheService: ICacheService,
    private readonly cls: ClsService,
  ) {}

  async check(): Promise<void> {
    const ip = this.cls.get<string | undefined>(MCP_IP_KEY);
    if (!ip) {
      // Fail closed: without an IP the limit cannot be applied
      throw new McpToolError('INTERNAL_ERROR', 'Internal error.');
    }
    const count = await this.cacheService.increment(
      `mcp:fanout:${ip}`,
      WINDOW_SECONDS,
    );
    if (count > MAX_FANOUT_CALLS) {
      throw new McpToolError(
        'RATE_LIMITED',
        `At most ${MAX_FANOUT_CALLS} calls a minute may omit chainIds. Pass chainIds, or retry later.`,
      );
    }
  }
}
