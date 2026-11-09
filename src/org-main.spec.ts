import { Controller, Get, Global, Module, Post } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { IConfigurationService } from '@/config/configuration.service.interface';
import { CacheReadiness } from '@/domain/interfaces/cache-readiness.interface';
import { LoggingService } from '@/logging/logging.interface';
import { configureOrgApp } from '@/org-main';
import { OrgHealthController } from '@/modules/org/health/org-health.controller';

const ping = jest.fn();
const PUBLIC_APP_URL = 'https://app.example.com';

@Controller({ path: 'orgs', version: '1' })
class OrgsStubController {
  @Get()
  list(): { ok: string } {
    return { ok: 'list' };
  }

  @Post()
  create(): { ok: string } {
    return { ok: 'create' };
  }

  @Get('health')
  health(): { ok: string } {
    return { ok: 'health' };
  }
}

// Stand-ins for routes the org process must not expose
@Controller({ path: 'chains', version: '1' })
class ChainsStubController {
  @Get()
  list(): { leaked: boolean } {
    return { leaked: true };
  }
}

@Controller({ path: 'auth', version: '1' })
class GatewayAuthStubController {
  @Get('nonce')
  nonce(): { leaked: boolean } {
    return { leaked: true };
  }
}

// Would answer 200 if the allowlist let a look-alike prefix or a param route through
@Controller({ path: 'orgsx', version: '1' })
class LookalikeStubController {
  @Get()
  get(): { leaked: boolean } {
    return { leaked: true };
  }
}

@Controller({ version: '1' })
class ParamStubController {
  @Get(':x')
  get(): { leaked: boolean } {
    return { leaked: true };
  }
}

@Module({
  controllers: [
    OrgsStubController,
    ChainsStubController,
    GatewayAuthStubController,
    OrgHealthController,
    LookalikeStubController,
    ParamStubController,
  ],
})
class StubModule {}

async function createApp(
  hops: string | number,
): Promise<NestExpressApplication> {
  const config: Record<string, unknown> = {
    'org.trustProxyHops': hops,
    'org.publicAppUrl': PUBLIC_APP_URL,
    'express.jsonLimit': '1mb',
  };
  @Global()
  @Module({
    providers: [
      {
        provide: IConfigurationService,
        useValue: {
          getOrThrow: (k: string): unknown => config[k],
          get: (k: string): unknown => config[k],
        },
      },
      {
        provide: CacheReadiness,
        useValue: { ping },
      },
      {
        provide: LoggingService,
        useValue: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
      },
    ],
    exports: [IConfigurationService, CacheReadiness, LoggingService],
  })
  class TestProvidersModule {}

  const moduleRef = await Test.createTestingModule({
    imports: [TestProvidersModule, StubModule],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  configureOrgApp(app);
  await app.init();
  return app;
}

describe('configureOrgApp', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    ping.mockResolvedValue('PONG');
    app = await createApp(1);
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers 404 for /v1/chains and /v1/auth/nonce', async () => {
    await request(app.getHttpServer()).get('/v1/chains').expect(404);
    await request(app.getHttpServer()).get('/v1/auth/nonce').expect(404);
  });

  it('lets exact /v1/orgs through for GET and POST', async () => {
    await request(app.getHttpServer()).get('/v1/orgs').expect(200);
    await request(app.getHttpServer()).post('/v1/orgs').expect(201);
  });

  it('lets /v1/orgs/health and /health/live through', async () => {
    await request(app.getHttpServer()).get('/v1/orgs/health').expect(200);
    await request(app.getHttpServer())
      .get('/health/live')
      .expect(200)
      .expect({ status: 'OK' });
  });

  it('answers /health/live without touching Redis, /health/ready needs it', async () => {
    ping.mockRejectedValue(new Error('redis down'));

    await request(app.getHttpServer())
      .get('/health/live')
      .expect(200)
      .expect({ status: 'OK' });
    await request(app.getHttpServer()).get('/health/ready').expect(503);
    expect(ping).toHaveBeenCalledTimes(1);

    ping.mockResolvedValue('PONG');
    await request(app.getHttpServer()).get('/health/ready').expect(200);
  });

  it('does not treat /v1/orgsx, /v1/orgs-evil or any /v1/:x as org paths', async () => {
    await request(app.getHttpServer()).get('/v1/orgsx').expect(404);
    await request(app.getHttpServer()).get('/v1/orgs-evil').expect(404);
    await request(app.getHttpServer()).get('/v1/anything').expect(404);
  });

  it('answers a CORS preflight from the public app URL with credentials', async () => {
    const res = await request(app.getHttpServer())
      .options('/v1/orgs')
      .set('Origin', PUBLIC_APP_URL)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'Content-Type, X-Org-Request');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(PUBLIC_APP_URL);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers['access-control-allow-headers']).toBe(
      'Content-Type,X-Org-Request',
    );
    expect(res.headers['access-control-allow-methods']).toBe(
      'GET,POST,PATCH,DELETE',
    );
  });

  it('never reflects another origin in CORS', async () => {
    const res = await request(app.getHttpServer())
      .options('/v1/orgs')
      .set('Origin', 'https://evil.example.com')
      .set('Access-Control-Request-Method', 'POST');

    expect(res.headers['access-control-allow-origin']).toBe(PUBLIC_APP_URL);
  });

  // Placeholder: no auth/account controllers exist yet (Task 4+). Replace with
  // GET /v1/orgs/auth/me and DELETE /v1/orgs/account reaching their own handlers.
  it.todo('registers static controllers before :orgId routes');
});

describe('configureOrgApp trust proxy', () => {
  it.each(['abc', '-1', '1.5', '', 'true'])(
    'throws when ORG_TRUST_PROXY_HOPS is %p',
    async (hops) => {
      await expect(createApp(hops)).rejects.toThrow(/ORG_TRUST_PROXY_HOPS/);
    },
  );

  it('sets trust proxy to the hop count', async () => {
    const app = await createApp('2');
    expect(app.getHttpAdapter().getInstance().get('trust proxy')).toBe(2);
    await app.close();
  });
});
