import { Inject, Injectable } from '@nestjs/common';
import {
  CacheService,
  ICacheService,
} from '@/datasources/cache/cache.service.interface';

/**
 * Fixed-window counter on the org Redis (key prefix `org:`).
 * shortcut: fixed window allows up to 2x `limit` across a window boundary;
 * switch to a sliding window if that burst matters.
 */
@Injectable()
export class RateLimiter {
  constructor(@Inject(CacheService) private readonly cache: ICacheService) {}

  /** Counts one attempt; false once `limit` attempts happened in the window. */
  async hit(
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<boolean> {
    // deviation 0: the window must not be randomly stretched
    const count = await this.cache.increment(
      `ratelimit:${key}`,
      windowSeconds,
      0,
    );
    return count <= limit;
  }

  /** Takes back one attempt of `hit`, e.g. a success that should not count. */
  async refund(key: string, windowSeconds: number): Promise<void> {
    await this.cache.increment(`ratelimit:${key}`, windowSeconds, 0, -1);
  }
}
