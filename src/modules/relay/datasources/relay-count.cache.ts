import { CacheRouter } from '@/datasources/cache/cache.router';
import type { ICacheService } from '@/datasources/cache/cache.service.interface';
import type { Address } from 'viem';

/**
 * Per-Safe relay counter kept in the cache. Shared by every relay provider so
 * the daily-limit and no-fee-campaign relayers behave the same regardless of
 * which service broadcasts the transaction.
 */
export abstract class RelayCountCache {
  protected constructor(protected readonly cacheService: ICacheService) {}

  async getRelayCount(args: {
    chainId: string;
    address: Address;
  }): Promise<number> {
    const cacheDir = CacheRouter.getRelayCacheDir(args);
    const count = await this.cacheService.hGet(cacheDir);
    return count ? parseInt(count) : 0;
  }

  async setRelayCount(args: {
    chainId: string;
    address: Address;
    count: number;
    ttlSeconds: number;
  }): Promise<void> {
    const cacheDir = CacheRouter.getRelayCacheDir(args);
    await this.cacheService.hSet(
      cacheDir,
      args.count.toString(),
      args.ttlSeconds,
    );
  }
}
