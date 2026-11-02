import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createHash } from 'crypto';
import request from 'supertest';
import { BlocklistModule } from '@/config/entities/blocklist.module';
import configuration from '@/config/entities/__tests__/configuration';
import { TestBlocklistModule } from '@/config/entities/__tests__/test.blocklist.module';
import { TestCacheModule } from '@/datasources/cache/__tests__/test.cache.module';
import { CacheModule } from '@/datasources/cache/cache.module';
import {
  networkService,
  TestNetworkModule,
} from '@/datasources/network/__tests__/test.network.module';
import { rawify } from '@/validation/entities/raw.entity';
import { TestTxAuthNetworkModule } from '@/datasources/network/__tests__/test.tx-auth.network.module';
import { NetworkModule } from '@/datasources/network/network.module';
import { TxAuthNetworkModule } from '@/datasources/network/tx-auth.network.module';
import { TestLoggingModule } from '@/logging/__tests__/test.logging.module';
import { McpAppModule } from '@/mcp-app.module';
import { FakeMcpUsageStore } from '@/modules/mcp/usage/__tests__/fake-mcp-usage.store';
import { McpUsageStore } from '@/modules/mcp/usage/mcp-usage.store';
import { McpLoggingModule } from '@/modules/mcp/logging/mcp-logging.module';
import { configureMcpApp } from '@/mcp-main';

describe('configureMcpApp', () => {
  const originalHops = process.env.MCP_TRUST_PROXY_HOPS;
  const app = {
    enableShutdownHooks: jest.fn(),
    use: jest.fn(),
    set: jest.fn(),
  };

  beforeEach(() => {
    jest.resetAllMocks();
    delete process.env.MCP_TRUST_PROXY_HOPS;
  });

  afterAll(() => {
    if (originalHops === undefined) {
      delete process.env.MCP_TRUST_PROXY_HOPS;
    } else {
      process.env.MCP_TRUST_PROXY_HOPS = originalHops;
    }
  });

  it('trusts one hop by default and enables shutdown hooks', () => {
    configureMcpApp(app as unknown as NestExpressApplication);

    expect(app.set).toHaveBeenCalledWith('trust proxy', 1);
    expect(app.enableShutdownHooks).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['0', 0],
    ['2', 2],
  ])('trusts the configured hop count %s', (value, expected) => {
    process.env.MCP_TRUST_PROXY_HOPS = value;

    configureMcpApp(app as unknown as NestExpressApplication);

    expect(app.set).toHaveBeenCalledWith('trust proxy', expected);
  });

  it.each(['abc', '-1', '1.5', '', 'true', ' 1', '0x1'])(
    'rejects %j',
    (value) => {
      process.env.MCP_TRUST_PROXY_HOPS = value;

      expect(() =>
        configureMcpApp(app as unknown as NestExpressApplication),
      ).toThrow('MCP_TRUST_PROXY_HOPS must be a non-negative integer');
      expect(app.set).not.toHaveBeenCalled();
    },
  );
});

describe('configureMcpApp over real HTTP', () => {
  let app: NestExpressApplication;

  async function start(): Promise<void> {
    const moduleFixture = await Test.createTestingModule({
      imports: [McpAppModule.register(configuration)],
    })
      .overrideModule(BlocklistModule)
      .useModule(TestBlocklistModule)
      .overrideModule(CacheModule)
      .useModule(TestCacheModule)
      .overrideModule(NetworkModule)
      .useModule(TestNetworkModule)
      .overrideModule(TxAuthNetworkModule)
      .useModule(TestTxAuthNetworkModule)
      .overrideModule(McpLoggingModule)
      .useModule(TestLoggingModule)
      .overrideProvider(McpUsageStore)
      .useClass(FakeMcpUsageStore)
      .compile();
    app = moduleFixture.createNestApplication<NestExpressApplication>();
    configureMcpApp(app);
    await app.init();
  }

  const post = (xForwardedFor: string): request.Test =>
    request(app.getHttpServer())
      .post('/mcp')
      .set('X-Forwarded-For', xForwardedFor)
      .send({});

  beforeEach(async () => {
    jest.spyOn(console, 'debug').mockImplementation();
    jest.spyOn(console, 'info').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();
    delete process.env.MCP_TRUST_PROXY_HOPS;
    await start();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await app.close();
  });

  it.each([
    ['POST', '/v1/chains/1/transactions/0xabc/propose'],
    ['DELETE', '/v1/transactions/0xabc'],
    ['GET', '/api'],
    ['GET', '/mcp/other'],
  ])('answers 404 to %s %s', async (method, path) => {
    const response = await request(app.getHttpServer())[
      method.toLowerCase() as 'get'
    ](path);

    expect(response.status).toBe(404);
  });

  it.each(['/health/live', '/health/ready'])('serves %s', async (path) => {
    const response = await request(app.getHttpServer()).get(path);

    expect(response.status).not.toBe(404);
  });

  it('the 61st request in a minute gets 429', async () => {
    for (let i = 0; i < 60; i++) {
      expect((await post('203.0.113.5')).status).not.toBe(429);
    }

    expect((await post('203.0.113.5')).status).toBe(429);
  });

  it('two clients at different ingress-set addresses have separate buckets', async () => {
    for (let i = 0; i < 61; i++) {
      await post('203.0.113.5');
    }

    expect((await post('203.0.113.5')).status).toBe(429);
    expect((await post('203.0.113.6')).status).not.toBe(429);
  });

  it('a forged left-most X-Forwarded-For does not change the bucket', async () => {
    // One trusted hop: the ingress appends the real address, the client forges the rest
    for (let i = 0; i < 60; i++) {
      expect((await post(`1.2.3.${i}, 10.0.0.9`)).status).not.toBe(429);
    }

    expect((await post('1.2.3.99, 10.0.0.9')).status).toBe(429);
  });

  describe('tools/call through the transport', () => {
    const MODERN = '2026-07-28';
    const OWNER = '0x0000000000000000000000000000000000000001';

    async function callTool(
      name: string,
      args: object,
      headers: { ip: string; userAgent?: string },
    ): Promise<{
      status: number;
      result: { isError?: boolean; text: string };
    }> {
      const response = await request(app.getHttpServer())
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('MCP-Protocol-Version', MODERN)
        .set('Mcp-Method', 'tools/call')
        .set('Mcp-Name', name)
        .set('X-Forwarded-For', headers.ip)
        .set('User-Agent', headers.userAgent ?? 'supertest')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name,
            arguments: args,
            _meta: {
              'io.modelcontextprotocol/protocolVersion': MODERN,
              'io.modelcontextprotocol/clientCapabilities': {},
              'io.modelcontextprotocol/clientInfo': {
                name: 'claude-code',
                version: '1.0.0',
              },
            },
          },
        });
      const { result } = response.body as {
        result: { isError?: boolean; content: Array<{ text: string }> };
      };
      return {
        status: response.status,
        result: { isError: result.isError, text: result.content[0].text },
      };
    }

    beforeEach(() => {
      jest.mocked(networkService.get).mockResolvedValue({
        data: rawify({ count: 0, next: null, previous: null, results: [] }),
        status: 200,
      });
    });

    it('the sixth find_safes_by_owner without chainIds from one IP is RATE_LIMITED', async () => {
      const outcomes: Array<{ status: number; code: string }> = [];
      for (let i = 0; i < 6; i++) {
        const { status, result } = await callTool(
          'find_safes_by_owner',
          { ownerAddress: OWNER },
          { ip: '203.0.113.20' },
        );
        outcomes.push({
          status,
          code: result.isError ? JSON.parse(result.text).code : 'ok',
        });
      }

      expect(outcomes).toEqual([
        ...Array(5).fill({ status: 200, code: 'ok' }),
        { status: 200, code: 'RATE_LIMITED' },
      ]);
    });

    it('another IP has its own fan-out budget', async () => {
      for (let i = 0; i < 6; i++) {
        await callTool(
          'find_safes_by_owner',
          { ownerAddress: OWNER },
          { ip: '203.0.113.20' },
        );
      }

      const { result } = await callTool(
        'find_safes_by_owner',
        { ownerAddress: OWNER },
        { ip: '203.0.113.21' },
      );

      expect(result.isError).toBeUndefined();
    });

    it('counts the call and hashes the client from the IP and User-Agent in Cls', async () => {
      const store = app.get<FakeMcpUsageStore>(McpUsageStore);

      await callTool(
        'find_safes_by_owner',
        { ownerAddress: OWNER, chainIds: ['1'] },
        { ip: '203.0.113.30', userAgent: 'test-agent/1' },
      );
      await new Promise((resolve) => setImmediate(resolve));

      expect(store.calls).toEqual({
        'find_safes_by_owner|none|claude-code|ok': 1,
      });
      expect([...store.clients]).toEqual([
        createHash('sha256')
          .update(`203.0.113.30|test-agent/1|${store.salt}`)
          .digest('hex'),
      ]);
    });

    it('an unknown chainId creates no usage field', async () => {
      const store = app.get<FakeMcpUsageStore>(McpUsageStore);
      jest.mocked(networkService.get).mockRejectedValue(new Error('no chain'));

      const { result } = await callTool(
        'get_safe',
        { chainId: '99999999999', safeAddress: OWNER },
        { ip: '203.0.113.31' },
      );
      await new Promise((resolve) => setImmediate(resolve));

      expect(result.isError).toBe(true);
      expect(Object.keys(store.calls)).toHaveLength(1);
      expect(JSON.stringify(Object.keys(store.calls))).not.toContain(
        '99999999999',
      );
    });
  });
});
