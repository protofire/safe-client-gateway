import type { ClsService } from 'nestjs-cls';
import type { ICacheService } from '@/datasources/cache/cache.service.interface';
import { McpFanoutLimit } from '@/modules/mcp/mcp-fanout-limit';

describe('McpFanoutLimit', () => {
  const cache = { increment: jest.fn() };
  const cls = { get: jest.fn() };
  const limit = new McpFanoutLimit(
    cache as unknown as ICacheService,
    cls as unknown as ClsService,
  );

  beforeEach(() => jest.resetAllMocks());

  it('allows 5 and counts under mcp:fanout:<ip>', async () => {
    cls.get.mockReturnValue('203.0.113.5');
    cache.increment.mockResolvedValue(5);

    await expect(limit.check()).resolves.toBeUndefined();

    expect(cache.increment).toHaveBeenCalledWith('mcp:fanout:203.0.113.5', 60);
  });

  it('throws RATE_LIMITED on the 6th', async () => {
    cls.get.mockReturnValue('203.0.113.5');
    cache.increment.mockResolvedValue(6);

    await expect(limit.check()).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('fails closed without an IP', async () => {
    cls.get.mockReturnValue(undefined);

    await expect(limit.check()).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });
    expect(cache.increment).not.toHaveBeenCalled();
  });
});
