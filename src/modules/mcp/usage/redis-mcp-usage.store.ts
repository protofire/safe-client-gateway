import { randomBytes } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { RedisClientType } from '@/datasources/cache/cache.module';
import type {
  IMcpUsageStore,
  McpUsageDay,
} from '@/modules/mcp/usage/mcp-usage.store';

// ~400 days
const AGGREGATE_TTL_SECONDS = 34_560_000;
const SALT_TTL_SECONDS = 86_400;

@Injectable()
export class RedisMcpUsageStore implements IMcpUsageStore {
  constructor(
    @Inject('RedisClient') private readonly client: RedisClientType,
  ) {}

  async incrementCall(date: string, field: string): Promise<void> {
    const key = `mcp:usage:${date}`;
    await this.client
      .multi()
      .hIncrBy(key, field, 1)
      .expire(key, AGGREGATE_TTL_SECONDS)
      .exec();
  }

  async addClient(date: string, hash: string): Promise<void> {
    const key = `mcp:clients:${date}`;
    await this.client
      .multi()
      .pfAdd(key, hash)
      .expire(key, AGGREGATE_TTL_SECONDS)
      .exec();
  }

  async getDay(date: string): Promise<McpUsageDay> {
    const [raw, clients] = await Promise.all([
      this.client.hGetAll(`mcp:usage:${date}`),
      this.client.pfCount(`mcp:clients:${date}`),
    ]);
    const calls = Object.fromEntries(
      Object.entries(raw).map(([field, count]) => [field, Number(count)]),
    );
    return { calls, clients };
  }

  async getDailySalt(date: string): Promise<string> {
    const key = `mcp:salt:${date}`;
    const fresh = randomBytes(32).toString('hex');
    // SET NX GET returns the existing value, or null when it stored `fresh`
    const existing = await this.client.set(key, fresh, {
      NX: true,
      EX: SALT_TTL_SECONDS,
      GET: true,
    });
    return existing ?? fresh;
  }
}
