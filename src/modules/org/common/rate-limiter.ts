import { Inject, Injectable } from '@nestjs/common';
import { isIPv4, isIPv6 } from 'node:net';
import {
  ORG_REDIS,
  OrgKeyPrefix,
  type OrgRedisClient,
} from '@/modules/org/auth/nonce.store';

// Never creates the key, never goes below 0: a refund after the window expired is a no-op
const REFUND_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 1 and tonumber(redis.call('GET', KEYS[1])) > 0 then
  return redis.call('DECR', KEYS[1])
end
return 0`;

/**
 * Rate-limit key part for a client IP: IPv4 as is, IPv6 by its /64 prefix
 * (one subscriber usually holds a whole /64), IPv4-mapped IPv6 as IPv4.
 */
export function ipBucket(ip: string): string {
  const address = ip.replace(/%.*$/, '');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped && isIPv4(mapped[1])) return mapped[1];
  if (!isIPv6(address)) return ip;

  const [head, tail] = address.split('::');
  const groups = (part: string | undefined): Array<string> =>
    part ? part.split(':') : [];
  let hextets = groups(head);
  if (tail !== undefined) {
    const tailGroups = groups(tail);
    // an embedded IPv4 tail fills two hextets
    const tailLength =
      tailGroups.length + (tailGroups.at(-1)?.includes('.') ? 1 : 0);
    hextets = [
      ...hextets,
      ...Array<string>(8 - hextets.length - tailLength).fill('0'),
      ...tailGroups,
    ];
  }
  const prefix = hextets.slice(0, 4).map((h) => parseInt(h, 16).toString(16));
  return `${prefix.join(':')}::/64`;
}

/**
 * Fixed-window counter on the org Redis.
 * shortcut: fixed window allows up to 2x `limit` across a window boundary;
 * switch to a sliding window if that burst matters.
 */
@Injectable()
export class RateLimiter {
  private readonly keyPrefix: string;

  constructor(
    @Inject(ORG_REDIS) private readonly redis: OrgRedisClient,
    @Inject(OrgKeyPrefix) prefix: string,
  ) {
    this.keyPrefix = `${prefix}ratelimit:`;
  }

  /** Counts one attempt; false once `limit` attempts happened in the window. */
  async hit(
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<boolean> {
    const k = this.keyPrefix + key;
    const [count] = await this.redis
      .multi()
      .incr(k)
      // NX: the window starts at the first attempt and is never stretched
      .expire(k, windowSeconds, 'NX')
      .exec();
    return Number(count) <= limit;
  }

  /** Takes back one attempt of `hit`, e.g. a success that should not count. */
  async refund(key: string): Promise<void> {
    await this.redis.eval(REFUND_SCRIPT, { keys: [this.keyPrefix + key] });
  }
}
