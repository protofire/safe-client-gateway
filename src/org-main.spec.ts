import { Controller, Get, Global, Module, Post } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { IConfigurationService } from '@/config/configuration.service.interface';
import { CacheReadiness } from '@/domain/interfaces/cache-readiness.interface';
import { LoggingService } from '@/logging/logging.interface';
import { configureOrgApp } from '@/org-main';
import { OrgHealthController } from '@/modules/org/health/org-health.controller';
import { getDataSourceToken } from '@nestjs/typeorm';
import { ORG_DATA_SOURCE } from '@/modules/org/db/org-data-source';
import { AuthService } from '@/modules/org/auth/auth.service';
import { OrgAuthModule } from '@/modules/org/auth/org-auth.module';
import { SessionGuard } from '@/modules/org/auth/session.guard';
import { SessionsRepository } from '@/modules/org/auth/sessions.repository';
import { RateLimiter } from '@/modules/org/common/rate-limiter';
import { SecurityEvents } from '@/modules/org/auth/security-events';
import { FieldEncryptionService } from '@/modules/org/crypto/field-encryption.service';
import { ORG_REDIS } from '@/modules/org/auth/nonce.store';

const ping = jest.fn();
const dbQuery = jest.fn();
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
        provide: getDataSourceToken(ORG_DATA_SOURCE),
        useValue: { query: dbQuery },
      },
      {
        provide: LoggingService,
        useValue: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
      },
    ],
    exports: [
      IConfigurationService,
      CacheReadiness,
      LoggingService,
      getDataSourceToken(ORG_DATA_SOURCE),
    ],
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
    dbQuery.mockResolvedValue([{ '?column?': 1 }]);
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

  it('answers /health/live without the database, /health/ready needs it', async () => {
    dbQuery.mockClear();
    dbQuery.mockRejectedValue(new Error('postgres down'));

    await request(app.getHttpServer()).get('/health/live').expect(200);
    expect(dbQuery).not.toHaveBeenCalled();
    await request(app.getHttpServer()).get('/health/ready').expect(503);
    expect(dbQuery).toHaveBeenCalledWith('SELECT 1');

    dbQuery.mockResolvedValue([{ '?column?': 1 }]);
    await request(app.getHttpServer()).get('/health/ready').expect(200);
  });

  it('answers /health/ready 503 when the database hangs past 2 s', async () => {
    dbQuery.mockReturnValue(new Promise(() => {}));
    try {
      await request(app.getHttpServer()).get('/health/ready').expect(503);
    } finally {
      dbQuery.mockResolvedValue([{ '?column?': 1 }]);
    }
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
});

// An /v1/orgs/:orgId/... route that would swallow /v1/orgs/auth/me if it were
// registered first
@Controller({ path: 'orgs', version: '1' })
class OrgIdStubController {
  @Get(':orgId/:resource')
  get(): { leaked: boolean } {
    return { leaked: true };
  }
}

@Module({ controllers: [OrgIdStubController] })
class OrgIdStubModule {}

describe('route order', () => {
  // Same order as OrgAppModule: OrgAuthModule before any :orgId module
  it('GET /v1/orgs/auth/me reaches its own handler, not /v1/orgs/:orgId/:resource', async () => {
    const session = {
      id: 'session-1',
      userId: 'user-1',
      amr: ['siwe'],
      lastStrongAuthAt: null,
      updatedAt: new Date(),
    };
    const me = jest.fn().mockResolvedValue({ user: { id: 'user-1' } });
    const config: Record<string, unknown> = {
      'org.trustProxyHops': 1,
      'org.publicAppUrl': PUBLIC_APP_URL,
      'express.jsonLimit': '1mb',
      'org.session.idleTtlSeconds': 3600,
      'org.session.strongAuthWindowSeconds': 1800,
    };
    @Global()
    @Module({
      providers: [
        {
          provide: IConfigurationService,
          useValue: { getOrThrow: (k: string): unknown => config[k] },
        },
      ],
      exports: [IConfigurationService],
    })
    class ConfigStubModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigStubModule, OrgAuthModule, OrgIdStubModule],
      // only the session guard of ORG_APP_GUARDS: /auth/me needs req.orgSession
      providers: [{ provide: APP_GUARD, useClass: SessionGuard }],
    })
      .overrideProvider(SessionsRepository)
      .useValue({ findActive: jest.fn().mockResolvedValue(session) })
      .overrideProvider(AuthService)
      .useValue({ me })
      .overrideProvider(RateLimiter)
      .useValue({})
      .overrideProvider(SecurityEvents)
      .useValue({})
      .overrideProvider(FieldEncryptionService)
      .useValue({})
      .overrideProvider(ORG_REDIS)
      .useValue({ quit: jest.fn() })
      .compile();
    const app = moduleRef.createNestApplication<NestExpressApplication>();
    configureOrgApp(app);
    await app.init();
    try {
      await request(app.getHttpServer())
        .get('/v1/orgs/auth/me')
        .set('Cookie', 'org_session=token')
        .expect(200)
        .expect({ user: { id: 'user-1' } });
      expect(me).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-1', sessionId: 'session-1' }),
      );
      // the stub is mounted and reachable for real org ids
      await request(app.getHttpServer())
        .get('/v1/orgs/7d3e/members')
        .set('Cookie', 'org_session=token')
        .expect(200)
        .expect({ leaked: true });
    } finally {
      await app.close();
    }
  });
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
