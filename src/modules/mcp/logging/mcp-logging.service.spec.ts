import { faker } from '@faker-js/faker';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'net';
import request from 'supertest';
import { getAddress, zeroAddress } from 'viem';
import configuration from '@/config/entities/__tests__/configuration';
import { BlocklistModule } from '@/config/entities/blocklist.module';
import { TestBlocklistModule } from '@/config/entities/__tests__/test.blocklist.module';
import { CacheModule } from '@/datasources/cache/cache.module';
import { TestCacheModule } from '@/datasources/cache/__tests__/test.cache.module';
import { LogType } from '@/domain/common/entities/log-type.entity';
import { McpAppModule } from '@/mcp-app.module';
import { chainBuilder } from '@/modules/chains/domain/entities/__tests__/chain.builder';
import { redact } from '@/modules/mcp/logging/mcp-logging.service';
import { safeBuilder } from '@/modules/safe/domain/entities/__tests__/safe.builder';
import { FakeMcpUsageStore } from '@/modules/mcp/usage/__tests__/fake-mcp-usage.store';
import { McpUsageStore } from '@/modules/mcp/usage/mcp-usage.store';

const address = (): `0x${string}` =>
  getAddress(faker.finance.ethereumAddress());

describe('redact', () => {
  const hex = address();

  it.each([
    [LogType.CacheHit],
    [LogType.CacheMiss],
    [LogType.ExternalRequestCacheHit],
    [LogType.ExternalRequestCacheMiss],
    [LogType.ExternalRequestCacheError],
  ])('drops %s', (type) => {
    expect(redact({ type, key: `1_safe_${hex}` })).toBeUndefined();
  });

  it('drops the request line and keeps a failed request without its path', () => {
    const failure = {
      type: LogType.ExternalRequest,
      target_host: 'tx.test',
      path: `/api/v1/safes/${hex}`,
      request_status: 500,
    };

    expect(
      redact({ type: LogType.ExternalRequest, method: 'GET', url: 'x' }),
    ).toBeUndefined();
    expect(redact(failure)).toEqual({
      type: LogType.ExternalRequest,
      target_host: 'tx.test',
      request_status: 500,
    });
  });

  it('scrubs addresses and URLs anywhere else', () => {
    expect(
      redact({
        message: `failed for ${hex} at https://tx.test/api/v1/safes/`,
        nested: [{ [hex]: hex, path: ['owners', 0] }],
      }),
    ).toEqual({
      message: 'failed for [redacted] at [redacted]',
      nested: [{ '[redacted]': '[redacted]', path: ['owners', 0] }],
    });
    expect(redact(`bad ${hex}`)).toBe('bad [redacted]');
  });

  it('keeps ordinary entries', () => {
    const entry = { type: LogType.CircuitBreakerRegistered, failureCount: 3 };

    expect(redact(entry)).toEqual(entry);
  });
});

describe('McpLoggingService on the real network service', () => {
  let app: INestApplication<Server>;
  const log = jest.fn();
  const chain = chainBuilder().with('chainId', '1').build();
  const safe = safeBuilder()
    .with('threshold', 1)
    .with('modules', [])
    .with('guard', zeroAddress)
    .build();
  const missing = address();

  function fetchStub(input: unknown): Promise<Response> {
    const url = String(input);
    if (url.endsWith('/api/v1/chains/1')) {
      return Promise.resolve(Response.json(chain));
    }
    if (url.endsWith(`/api/v1/safes/${safe.address}`)) {
      return Promise.resolve(
        Response.json({ ...safe, nonce: safe.nonce.toString() }),
      );
    }
    return Promise.resolve(
      Response.json({ message: `No ${missing}` }, { status: 404 }),
    );
  }

  async function getSafe(safeAddress: string): Promise<void> {
    await request(app.getHttpServer())
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .set('MCP-Protocol-Version', '2026-07-28')
      .set('Mcp-Method', 'tools/call')
      .set('Mcp-Name', 'get_safe')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'get_safe',
          arguments: { chainId: '1', safeAddress },
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      })
      .expect(200);
  }

  beforeEach(async () => {
    log.mockClear();
    const realClientConfiguration = (): ReturnType<typeof configuration> => {
      const config = configuration();
      return {
        ...config,
        features: { ...config.features, cacheInFlightRequests: true },
        httpClient: { ...config.httpClient, requestTimeout: 5_000 },
      };
    };
    const moduleFixture = await Test.createTestingModule({
      imports: [McpAppModule.register(realClientConfiguration)],
    })
      .overrideModule(BlocklistModule)
      .useModule(TestBlocklistModule)
      .overrideModule(CacheModule)
      .useModule(TestCacheModule)
      .overrideProvider('Logger')
      .useValue({ log })
      .overrideProvider(McpUsageStore)
      .useClass(FakeMcpUsageStore)
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await app.close();
  });

  it('logs no address on a miss, a hit or a 404, and keeps the 404 visible', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(fetchStub);

    await getSafe(safe.address);
    await getSafe(safe.address);
    await getSafe(missing);

    const fetched = fetchSpy.mock.calls.map(([url]) => url as string).join();
    expect(fetched).toContain(safe.address);
    expect(fetched).toContain(missing);
    const logged = JSON.stringify(log.mock.calls).toLowerCase();
    expect(logged).not.toContain(safe.address.toLowerCase());
    expect(logged).not.toContain(missing.toLowerCase());
    expect(logged).not.toContain('/api/v1/safes');
    expect(log).toHaveBeenCalledWith(
      'debug',
      expect.objectContaining({
        message: expect.objectContaining({
          type: LogType.ExternalRequest,
          request_status: 404,
        }),
      }),
    );
  });
});
