import {
  Controller,
  Delete,
  Get,
  Global,
  Module,
  Post,
  type DynamicModule,
  type Type,
} from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
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
import { AccountController } from '@/modules/org/account/account.controller';
import { OrgAccountModule } from '@/modules/org/account/account.module';
import { AccountService } from '@/modules/org/account/account.service';
import { ActivityModule } from '@/modules/org/activity/activity.module';
import { AddressBookModule } from '@/modules/org/address-book/address-book.module';
import { InvitationsController } from '@/modules/org/members/invitations.controller';
import { InvitationsService } from '@/modules/org/members/invitations.service';
import { MembersController } from '@/modules/org/members/members.controller';
import { MembersModule } from '@/modules/org/members/members.module';
import { OrgsModule } from '@/modules/org/orgs/orgs.module';
import { SafesModule } from '@/modules/org/safes/safes.module';
import { OrgAppModule } from '@/org-app.module';

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
      'GET,POST,PUT,PATCH,DELETE',
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

// /v1/orgs/:orgId routes that would swallow the static account and
// invitation routes if they were registered first
@Controller({ path: 'orgs', version: '1' })
class OrgIdWriteStubController {
  @Delete(':orgId')
  delete(): { leaked: boolean } {
    return { leaked: true };
  }

  @Post(':orgId/:resource')
  post(): { leaked: boolean } {
    return { leaked: true };
  }
}

@Module({ controllers: [OrgIdWriteStubController] })
class OrgIdWriteStubModule {}

describe('route order of static org routes', () => {
  it('registers the account and invitation modules before every :orgId module in OrgAppModule', () => {
    const imports = (OrgAppModule.register().imports ?? []) as Array<
      Type | DynamicModule
    >;
    const at = (m: Type): number => imports.indexOf(m);

    for (const staticModule of [
      OrgAuthModule,
      OrgAccountModule,
      MembersModule,
    ]) {
      for (const orgIdModule of [
        OrgsModule,
        ActivityModule,
        SafesModule,
        AddressBookModule,
      ]) {
        expect(at(staticModule)).toBeGreaterThanOrEqual(0);
        expect(at(staticModule)).toBeLessThan(at(orgIdModule));
      }
    }
    expect(
      Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, MembersModule),
    ).toEqual([InvitationsController, MembersController]);
  });

  it('DELETE /v1/orgs/account and POST /v1/orgs/invitations/accept reach their own handlers', async () => {
    const session = {
      id: 'session-1',
      userId: 'user-1',
      amr: ['siwe'],
      lastStrongAuthAt: new Date(),
      updatedAt: new Date(),
    };
    const deleteAccount = jest.fn().mockResolvedValue(undefined);
    const acceptByToken = jest.fn().mockResolvedValue({ orgId: 'org-1' });
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
    @Module({
      controllers: [AccountController],
      providers: [
        { provide: AccountService, useValue: { delete: deleteAccount } },
      ],
    })
    class AccountStubModule {}
    @Module({
      controllers: [InvitationsController],
      providers: [{ provide: InvitationsService, useValue: { acceptByToken } }],
    })
    class InvitationsStubModule {}

    const moduleRef = await Test.createTestingModule({
      // same order as OrgAppModule (asserted above)
      imports: [
        ConfigStubModule,
        OrgAuthModule,
        AccountStubModule,
        InvitationsStubModule,
        OrgIdWriteStubModule,
      ],
      providers: [{ provide: APP_GUARD, useClass: SessionGuard }],
    })
      .overrideProvider(SessionsRepository)
      .useValue({ findActive: jest.fn().mockResolvedValue(session) })
      .overrideProvider(AuthService)
      .useValue({ stepUpMethods: jest.fn().mockResolvedValue(['siwe']) })
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
        .delete('/v1/orgs/account')
        .set('Cookie', 'org_session=token')
        .expect(204);
      expect(deleteAccount).toHaveBeenCalledWith('user-1');
      await request(app.getHttpServer())
        .post('/v1/orgs/invitations/accept')
        .set('Cookie', 'org_session=token')
        .send({ token: 'a'.repeat(43) })
        .expect(200)
        .expect({ orgId: 'org-1' });
      expect(acceptByToken).toHaveBeenCalledWith(
        'a'.repeat(43),
        expect.objectContaining({ userId: 'user-1' }),
      );
      // the stub is mounted and reachable for real org ids
      await request(app.getHttpServer())
        .delete('/v1/orgs/7d3e')
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
