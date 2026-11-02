import { HttpException, type ExecutionContext } from '@nestjs/common';
import type { ClsService } from 'nestjs-cls';
import type { ICacheService } from '@/datasources/cache/cache.service.interface';
import type { ILoggingService } from '@/logging/logging.interface';
import {
  MCP_IP_KEY,
  McpRateLimitGuard,
} from '@/modules/mcp/routes/guards/mcp-rate-limit.guard';

describe('McpRateLimitGuard', () => {
  const cache = { increment: jest.fn() };
  const logger = { warn: jest.fn() };
  const cls = { set: jest.fn() };
  const guard = new McpRateLimitGuard(
    cache as unknown as ICacheService,
    logger as unknown as ILoggingService,
    cls as unknown as ClsService,
  );
  const contextFor = (ip: string): ExecutionContext =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({ ip, method: 'POST', route: { path: '/mcp' } }),
      }),
    }) as unknown as ExecutionContext;

  beforeEach(() => jest.resetAllMocks());

  it('counts per IP and shares the IP with the tools', async () => {
    cache.increment.mockResolvedValue(60);

    await expect(guard.canActivate(contextFor('203.0.113.5'))).resolves.toBe(
      true,
    );

    expect(cache.increment).toHaveBeenCalledWith(
      '/mcp_POST_203.0.113.5_rate_limit',
      60,
    );
    expect(cls.set).toHaveBeenCalledWith(MCP_IP_KEY, '203.0.113.5');
  });

  it('logs no clientIp on a rate limit hit or an invalid IP', async () => {
    cache.increment.mockResolvedValue(61);

    await expect(
      guard.canActivate(contextFor('203.0.113.5')),
    ).rejects.toBeInstanceOf(HttpException);
    await expect(guard.canActivate(contextFor('nonsense'))).rejects.toThrow();

    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('clientIp');
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('203.0.113.5');
    expect(cls.set).not.toHaveBeenCalled();
  });
});
