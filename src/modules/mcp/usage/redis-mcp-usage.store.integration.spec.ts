import { randomUUID } from 'crypto';
import { redisClientFactory } from '@/__tests__/redis-client.factory';
import type { RedisClientType } from '@/datasources/cache/cache.module';
import { RedisMcpUsageStore } from '@/modules/mcp/usage/redis-mcp-usage.store';

describe('RedisMcpUsageStore', () => {
  let client: RedisClientType;
  let store: RedisMcpUsageStore;
  // A fresh date per test keeps the keys apart without flushing the database
  let date: string;

  beforeAll(async () => {
    client = await redisClientFactory();
    store = new RedisMcpUsageStore(client);
  });

  afterAll(async () => {
    await client.quit();
  });

  beforeEach(() => {
    date = `test-${randomUUID()}`;
  });

  afterEach(async () => {
    await client.del([
      `mcp:usage:${date}`,
      `mcp:clients:${date}`,
      `mcp:salt:${date}`,
    ]);
  });

  it('HLL counts 3 distinct hashes as 3', async () => {
    for (const hash of ['a', 'b', 'c', 'a']) {
      await store.addClient(date, hash);
    }

    await expect(store.getDay(date)).resolves.toEqual({
      calls: {},
      clients: 3,
    });
  });

  it('counts calls per field', async () => {
    await store.incrementCall(date, 'get_safe|1|other|ok');
    await store.incrementCall(date, 'get_safe|1|other|ok');
    await store.incrementCall(date, 'list_chains|none|other|ok');

    const { calls } = await store.getDay(date);

    expect(calls).toEqual({
      'get_safe|1|other|ok': 2,
      'list_chains|none|other|ok': 1,
    });
  });

  it('salt keeps its value within a date', async () => {
    const first = await store.getDailySalt(date);
    const second = await store.getDailySalt(date);

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toBe(first);
    await expect(store.getDailySalt(`${date}-next`)).resolves.not.toBe(first);
    await client.del(`mcp:salt:${date}-next`);
  });

  it('keys carry TTLs', async () => {
    await store.incrementCall(date, 'f');
    await store.addClient(date, 'h');
    await store.getDailySalt(date);

    await expect(client.ttl(`mcp:usage:${date}`)).resolves.toBeGreaterThan(
      34_559_000,
    );
    await expect(client.ttl(`mcp:clients:${date}`)).resolves.toBeGreaterThan(
      34_559_000,
    );
    const salt = await client.ttl(`mcp:salt:${date}`);
    expect(salt).toBeGreaterThan(0);
    expect(salt).toBeLessThanOrEqual(86_400);
  });
});
