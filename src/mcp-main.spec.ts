import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { BlocklistModule } from '@/config/entities/blocklist.module';
import configuration from '@/config/entities/__tests__/configuration';
import { TestBlocklistModule } from '@/config/entities/__tests__/test.blocklist.module';
import { TestCacheModule } from '@/datasources/cache/__tests__/test.cache.module';
import { CacheModule } from '@/datasources/cache/cache.module';
import { TestNetworkModule } from '@/datasources/network/__tests__/test.network.module';
import { TestTxAuthNetworkModule } from '@/datasources/network/__tests__/test.tx-auth.network.module';
import { NetworkModule } from '@/datasources/network/network.module';
import { TxAuthNetworkModule } from '@/datasources/network/tx-auth.network.module';
import { TestLoggingModule } from '@/logging/__tests__/test.logging.module';
import { McpAppModule } from '@/mcp-app.module';
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
});
