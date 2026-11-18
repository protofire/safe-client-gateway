import { randomUUID } from 'node:crypto';
import { Controller, Get, Global, Module, Post, Req } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { getDataSourceToken, TypeOrmModule } from '@nestjs/typeorm';
import type { Request } from 'express';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import type { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { IConfigurationService } from '@/config/configuration.service.interface';
import { CacheModule } from '@/datasources/cache/cache.module';
import { LoggingService } from '@/logging/logging.interface';
import { Public } from '@/modules/org/auth/decorators';
import {
  clearPrefix,
  listenForTests,
} from '@/modules/org/auth/__tests__/auth-test-app';
import {
  ORG_REDIS,
  OrgKeyPrefix,
  type OrgRedisClient,
} from '@/modules/org/auth/nonce.store';
import { OrgAuthModule } from '@/modules/org/auth/org-auth.module';
import { SessionsRepository } from '@/modules/org/auth/sessions.repository';
import {
  createOrgTestDb,
  type OrgTestDb,
} from '@/modules/org/db/__tests__/org-test-db';
import { ORG_DATA_SOURCE } from '@/modules/org/db/org-data-source';
import { PermissionResolver } from '@/modules/org/permissions/permission.resolver';
import { PermissionsModule } from '@/modules/org/permissions/permissions.module';
import { RequirePermission } from '@/modules/org/permissions/require-permission.decorator';
import { ORG_APP_GUARDS } from '@/org-app.module';
import { configureOrgApp } from '@/org-main';
import { runOrgMigrations } from '@/org-migrate';
import { GlobalErrorFilter } from '@/routes/common/filters/global-error.filter';
import { ZodErrorFilter } from '@/routes/common/filters/zod-error.filter';

// Redis DB 2 is shared with other lanes: a private prefix, cleaned by SCAN+DEL
const CACHE_PREFIX = `org:test:${randomUUID()}:`;

/**
 * Pins the global guard order of OrgAppModule (ORG_APP_GUARDS):
 * CsrfGuard → SessionGuard → OrgMemberGuard, with a real SIWE session.
 */
const APP_URL = 'https://app.example.com';

@Controller({ path: 'orgs/:orgId', version: '1' })
class PingController {
  @Get('ping')
  @RequirePermission('org.view')
  get(@Req() req: Request): { orgId?: string } {
    return { orgId: req.orgMember?.orgId };
  }

  @Post('ping')
  @RequirePermission('org.view')
  post(@Req() req: Request): { orgId?: string } {
    return { orgId: req.orgMember?.orgId };
  }

  @Get('undecorated')
  undecorated(): string {
    return 'leaked';
  }
}

@Controller({ path: 'orgs/public-ping', version: '1' })
class PublicPingController {
  @Get()
  @Public()
  get(): { ok: true } {
    return { ok: true };
  }
}

const config: Record<string, unknown> = {
  'org.trustProxyHops': 1,
  'org.encryption.keys': JSON.stringify({
    current: 'v1',
    keys: { v1: Buffer.alloc(32, 7).toString('base64') },
  }),
  'org.publicAppUrl': APP_URL,
  'express.jsonLimit': '1mb',
  'org.session.idleTtlSeconds': 12 * 3600,
  'org.session.absoluteTtlSeconds': 7 * 24 * 3600,
  'org.session.strongAuthWindowSeconds': 30 * 60,
  'auth.nonceTtlSeconds': 300,
  'redis.host': '127.0.0.1',
  'redis.port': '6379/2',
  'redis.connectTimeout': 10_000,
  'redis.keepAlive': 30_000,
  'redis.disableOfflineQueue': false,
  'expirationTimeInSeconds.default': 60,
  'expirationTimeInSeconds.deviatePercent': 0,
};

const logger = {
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
};

@Global()
@Module({
  providers: [
    {
      provide: IConfigurationService,
      useValue: {
        getOrThrow: (k: string): unknown => {
          if (config[k] === undefined) throw new Error(`missing ${k}`);
          return config[k];
        },
        get: (k: string): unknown => config[k],
      },
    },
    { provide: LoggingService, useValue: logger },
  ],
  exports: [IConfigurationService, LoggingService],
})
class TestProvidersModule {}

describe('org global guard order', () => {
  let db: OrgTestDb;
  let app: NestExpressApplication;
  let sql: DataSource;
  let findActive: jest.SpyInstance;
  let effective: jest.SpyInstance;
  let ipSeq = 0;

  // member and outsider each hold a real SIWE session
  let orgId: string;
  let memberCookie: string;
  let outsiderCookie: string;

  const nextIp = (): string =>
    `10.2.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;
  const http = (): ReturnType<typeof request> => request(app.getHttpServer());

  async function signIn(): Promise<{ cookie: string; userId: string }> {
    const account = privateKeyToAccount(generatePrivateKey());
    const { body } = await http()
      .get('/v1/orgs/auth/nonce')
      .set('X-Forwarded-For', nextIp())
      .expect(200);
    const message = createSiweMessage({
      address: account.address,
      chainId: 1,
      domain: 'app.example.com',
      nonce: body.nonce,
      uri: APP_URL,
      version: '1',
    });
    const res = await http()
      .post('/v1/orgs/auth/siwe')
      .set('X-Org-Request', '1')
      .set('X-Forwarded-For', nextIp())
      .send({ message, signature: await account.signMessage({ message }) })
      .expect(200);
    const match = /__Host-org_session=([^;]+)/.exec(
      [res.headers['set-cookie']].flat().join(';'),
    );
    if (!match) throw new Error('no __Host-org_session cookie');
    return {
      cookie: `__Host-org_session=${match[1]}`,
      userId: res.body.user.id,
    };
  }

  beforeAll(async () => {
    db = await createOrgTestDb();
    const owner = db.owner();
    await owner.initialize();
    await runOrgMigrations(owner, db.appUser);
    await owner.destroy();

    const moduleRef = await Test.createTestingModule({
      imports: [
        TestProvidersModule,
        CacheModule.register(CACHE_PREFIX),
        TypeOrmModule.forRoot({
          ...(db.app().options as PostgresConnectionOptions),
          name: ORG_DATA_SOURCE,
        }),
        OrgAuthModule,
        PermissionsModule,
      ],
      controllers: [PingController, PublicPingController],
      providers: [
        { provide: APP_FILTER, useClass: GlobalErrorFilter },
        { provide: APP_FILTER, useClass: ZodErrorFilter },
        ...ORG_APP_GUARDS,
      ],
    })
      .overrideProvider(OrgKeyPrefix)
      .useValue(CACHE_PREFIX)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureOrgApp(app);
    await listenForTests(app);
    sql = moduleRef.get<DataSource>(getDataSourceToken(ORG_DATA_SOURCE), {
      strict: false,
    });
    findActive = jest.spyOn(
      moduleRef.get(SessionsRepository, { strict: false }),
      'findActive',
    );
    effective = jest.spyOn(
      moduleRef.get(PermissionResolver, { strict: false }),
      'effective',
    );

    const member = await signIn();
    const outsider = await signIn();
    memberCookie = member.cookie;
    outsiderCookie = outsider.cookie;
    // one transaction: the org must keep an active admin at commit
    orgId = await sql.transaction(async (em) => {
      const [{ id }] = await em.query(
        `INSERT INTO organizations (name) VALUES ('org') RETURNING id`,
      );
      const [{ id: adminUserId }] = await em.query(
        `INSERT INTO users DEFAULT VALUES RETURNING id`,
      );
      for (const [userId, role] of [
        [adminUserId, 'admin'],
        [member.userId, 'member'],
      ]) {
        const [{ id: memberId }] = await em.query(
          `INSERT INTO members (org_id, user_id, status) VALUES ($1, $2, 'active') RETURNING id`,
          [id, userId],
        );
        await em.query(
          `INSERT INTO role_bindings (member_id, role_id, scope)
             SELECT $1, id, 'org' FROM roles WHERE org_id IS NULL AND key = $2`,
          [memberId, role],
        );
      }
      return id;
    });
  });

  afterAll(async () => {
    const redis = app?.get<OrgRedisClient>(ORG_REDIS, { strict: false });
    if (redis?.isReady) await clearPrefix(redis, CACHE_PREFIX);
    await app?.close();
    await db?.drop();
  });

  beforeEach(() => {
    findActive.mockClear();
    effective.mockClear();
    logger.error.mockClear();
  });

  it('GET without a cookie → 401, before the tenant guard', async () => {
    await http().get(`/v1/orgs/${orgId}/ping`).expect(401);
    expect(effective).not.toHaveBeenCalled();
  });

  it('valid session, non-member → 404', async () => {
    await http()
      .get(`/v1/orgs/${orgId}/ping`)
      .set('Cookie', outsiderCookie)
      .expect(404);
    expect(effective).toHaveBeenCalledTimes(1);
  });

  it('member → 200 with req.orgMember attached', async () => {
    await http()
      .get(`/v1/orgs/${orgId}/ping`)
      .set('Cookie', memberCookie)
      .expect(200)
      .expect({ orgId });
  });

  it('member POST with X-Org-Request → 201', async () => {
    await http()
      .post(`/v1/orgs/${orgId}/ping`)
      .set('Cookie', memberCookie)
      .set('X-Org-Request', '1')
      .expect(201)
      .expect({ orgId });
  });

  it('POST without X-Org-Request → 403 before any session lookup', async () => {
    await http()
      .post(`/v1/orgs/${orgId}/ping`)
      .set('Cookie', memberCookie)
      .expect(403);
    // no cookie either: SessionGuard first would answer 401
    await http().post(`/v1/orgs/${orgId}/ping`).expect(403);
    expect(findActive).not.toHaveBeenCalled();
    expect(effective).not.toHaveBeenCalled();
  });

  it('@Public route without a session passes', async () => {
    await http().get('/v1/orgs/public-ping').expect(200).expect({ ok: true });
    expect(findActive).not.toHaveBeenCalled();
  });

  it(':orgId route without @RequirePermission → 403 for a member', async () => {
    await http()
      .get(`/v1/orgs/${orgId}/undecorated`)
      .set('Cookie', memberCookie)
      .expect(403);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('no @RequirePermission()'),
    );
  });

  it(':orgId route without @RequirePermission and no cookie → 401 (session runs first)', async () => {
    await http().get(`/v1/orgs/${orgId}/undecorated`).expect(401);
    expect(logger.error).not.toHaveBeenCalled();
  });
});
