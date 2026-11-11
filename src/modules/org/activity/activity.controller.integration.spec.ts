import { randomUUID } from 'node:crypto';
import { Global, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { getDataSourceToken, TypeOrmModule } from '@nestjs/typeorm';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import type { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { IConfigurationService } from '@/config/configuration.service.interface';
import { CacheModule } from '@/datasources/cache/cache.module';
import { LoggingService } from '@/logging/logging.interface';
import { ActivityLog } from '@/modules/org/activity/activity-log.service';
import { ActivityModule } from '@/modules/org/activity/activity.module';
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
import {
  createOrgTestDb,
  type OrgTestDb,
} from '@/modules/org/db/__tests__/org-test-db';
import { ORG_DATA_SOURCE } from '@/modules/org/db/org-data-source';
import { PermissionsModule } from '@/modules/org/permissions/permissions.module';
import { ORG_APP_GUARDS } from '@/org-app.module';
import { configureOrgApp } from '@/org-main';
import { runOrgMigrations } from '@/org-migrate';
import { GlobalErrorFilter } from '@/routes/common/filters/global-error.filter';
import { ZodErrorFilter } from '@/routes/common/filters/zod-error.filter';

// Redis DB 2 is shared with other lanes: a private prefix, cleaned by SCAN+DEL
const CACHE_PREFIX = `org:test:${randomUUID()}:`;
const APP_URL = 'https://app.example.com';

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

describe('org activity log', () => {
  let db: OrgTestDb;
  let app: NestExpressApplication;
  let sql: DataSource;
  let log: ActivityLog;
  let ipSeq = 0;
  let orgId: string;
  let admin: { cookie: string; userId: string };
  let member: { cookie: string; userId: string };
  let outsider: { cookie: string; userId: string };

  const nextIp = (): string =>
    `10.3.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;
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

  async function createOrg(users: Array<[string, string]>): Promise<string> {
    return sql.transaction(async (em) => {
      const [{ id }] = await em.query(
        `INSERT INTO organizations (name) VALUES ('org') RETURNING id`,
      );
      for (const [userId, role] of users) {
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
  }

  const record = (
    e: Partial<Parameters<ActivityLog['record']>[1]> = {},
    org: string = orgId,
  ): Promise<void> =>
    sql.transaction((em) =>
      log.record(em, {
        orgId: org,
        actorUserId: admin.userId,
        type: 'org.renamed',
        payload: { from: 'a', to: 'b' },
        ...e,
      }),
    );

  const list = (cookie: string, qs = '', org: string = orgId): request.Test =>
    http().get(`/v1/orgs/${org}/activity${qs}`).set('Cookie', cookie);

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
        ActivityModule,
      ],
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
    log = moduleRef.get(ActivityLog);

    admin = await signIn();
    member = await signIn();
    outsider = await signIn();
    orgId = await createOrg([
      [admin.userId, 'admin'],
      [member.userId, 'member'],
    ]);
    await createOrg([[outsider.userId, 'admin']]);
  });

  afterAll(async () => {
    const redis = app?.get<OrgRedisClient>(ORG_REDIS, { strict: false });
    if (redis?.isReady) await clearPrefix(redis, CACHE_PREFIX);
    await app?.close();
    await db?.drop();
  });

  beforeEach(async () => {
    await sql.query(`DELETE FROM activity_events`);
  });

  it('hides ip and userAgent from a member who is not the actor, shows them to an admin and to the actor', async () => {
    await record({
      actorUserId: member.userId,
      type: 'safe.linked',
      ip: '203.0.113.9',
      userAgent: 'jest-agent',
    });
    const [asMember, asAdmin] = await Promise.all([
      list(member.cookie).expect(200),
      list(admin.cookie).expect(200),
    ]);
    expect(asAdmin.body.items[0]).toMatchObject({
      ip: '203.0.113.9',
      userAgent: 'jest-agent',
    });
    // the member is the actor here
    expect(asMember.body.items[0]).toMatchObject({ ip: '203.0.113.9' });

    await record({
      actorUserId: admin.userId,
      ip: '198.51.100.1',
      userAgent: 'admin-agent',
    });
    const res = await list(member.cookie).expect(200);
    const row = res.body.items[0];
    expect(row.actorUserId).toBe(admin.userId);
    expect(row).not.toHaveProperty('ip');
    expect(row).not.toHaveProperty('userAgent');
    const [stored] = await sql.query(
      `SELECT ip_encrypted FROM activity_events WHERE ip_encrypted IS NOT NULL LIMIT 1`,
    );
    expect(stored.ip_encrypted).not.toContain('203.0.113.9');
  });

  it('nulls a deleted actor and omits ip/userAgent', async () => {
    const [{ id: ghost }] = await sql.query(
      `INSERT INTO users (status, deleted_at) VALUES ('deleted', now()) RETURNING id`,
    );
    await record({ actorUserId: ghost, ip: '192.0.2.1', userAgent: 'x' });
    const { body } = await list(admin.cookie).expect(200);
    expect(body.items[0].actorUserId).toBeNull();
    expect(body.items[0]).not.toHaveProperty('ip');
    expect(body.items[0]).not.toHaveProperty('userAgent');
  });

  it('paginates with a stable cursor', async () => {
    for (let i = 0; i < 5; i++) await record({ targetId: `t${i}` });
    const first = await list(admin.cookie, '?limit=2').expect(200);
    expect(
      (first.body.items as Array<Record<string, string>>).map(
        (i) => i.targetId,
      ),
    ).toEqual(['t4', 't3']);
    await record({ targetId: 'inserted-during' });
    const second = await list(
      admin.cookie,
      `?limit=2&cursor=${first.body.nextCursor}`,
    ).expect(200);
    const third = await list(
      admin.cookie,
      `?limit=2&cursor=${second.body.nextCursor}`,
    ).expect(200);
    expect(
      (
        [...second.body.items, ...third.body.items] as Array<
          Record<string, string>
        >
      ).map((i) => i.targetId),
    ).toEqual(['t2', 't1', 't0']);
    expect(third.body.nextCursor).toBeNull();
    await list(admin.cookie, '?cursor=garbage').expect(400);
    await list(admin.cookie, '?limit=101').expect(400);
    const forged = Buffer.from(
      JSON.stringify(['not-a-date', admin.userId]),
    ).toString('base64url');
    await list(admin.cookie, `?cursor=${forged}`).expect(400);
  });

  it('filters by type and actor', async () => {
    await record({ type: 'safe.linked' });
    await record({ type: 'org.renamed', actorUserId: member.userId });
    const byType = await list(admin.cookie, '?type=safe.linked').expect(200);
    expect(
      (byType.body.items as Array<Record<string, string>>).map((i) => i.type),
    ).toEqual(['safe.linked']);
    const byActor = await list(admin.cookie, `?actor=${member.userId}`).expect(
      200,
    );
    expect(byActor.body.items).toHaveLength(1);
    expect(byActor.body.items[0].actorUserId).toBe(member.userId);
  });

  it('excludes deleted users from the actor filter', async () => {
    const [{ id: ghost }] = await sql.query(
      `INSERT INTO users (status, deleted_at) VALUES ('deleted', now()) RETURNING id`,
    );
    await record({ actorUserId: ghost });
    const { body } = await list(admin.cookie, `?actor=${ghost}`).expect(200);
    expect(body.items).toEqual([]);
  });

  it('answers 404 to a user of another org', async () => {
    await list(outsider.cookie).expect(404);
    await http()
      .get(`/v1/orgs/${orgId}/activity.csv`)
      .set('Cookie', outsider.cookie)
      .expect(404);
  });

  it('rolls back the event when the surrounding change fails', async () => {
    await expect(
      sql.transaction(async (em) => {
        await log.record(em, {
          orgId,
          actorUserId: admin.userId,
          type: 'org.renamed',
        });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await sql.query(`SELECT 1 FROM activity_events`)).toHaveLength(0);
  });

  it('refuses to record outside a transaction', async () => {
    await expect(
      log.record(sql.manager, {
        orgId,
        actorUserId: admin.userId,
        type: 'org.renamed',
      }),
    ).rejects.toThrow('transaction');
  });

  describe('CSV', () => {
    const csv = (cookie: string, qs = ''): Promise<string> =>
      http()
        .get(`/v1/orgs/${orgId}/activity.csv${qs}`)
        .set('Cookie', cookie)
        .buffer(true)
        .parse((res, cb) => {
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (data += c));
          res.on('end', () => cb(null, data));
        })
        .expect(200)
        .then((r) => r.body as string);

    it('escapes formula-like cells', async () => {
      for (const v of ['=1+1', '+1', '-1', '@x', '\tx', '\rx']) {
        await record({ targetType: 'contact', targetId: v });
      }
      const out = await csv(admin.cookie);
      for (const v of ['=1+1', '+1', '-1', '@x', '\tx', '\rx']) {
        expect(out).toContain(`'${v}`);
      }
      expect(out).not.toMatch(/(^|,)=1\+1/m);
    });

    it('streams all pages (> 100 rows) and records export.downloaded', async () => {
      await sql.query(
        `INSERT INTO activity_events (org_id, actor_user_id, type, target_id)
         SELECT $1, $2, 'safe.linked', 'row' || g FROM generate_series(1, 1203) g`,
        [orgId, admin.userId],
      );
      const out = await csv(admin.cookie, '?type=safe.linked');
      const lines = out.trim().split('\n');
      expect(lines).toHaveLength(1204); // header + rows
      expect(new Set(lines.slice(1)).size).toBe(1203);
      const events = await sql.query(
        `SELECT payload, actor_user_id FROM activity_events WHERE type = 'export.downloaded'`,
      );
      expect(events).toHaveLength(1);
      expect(events[0].payload).toEqual({ what: 'activity' });
      expect(events[0].actor_user_id).toBe(admin.userId);
    });
  });

  it('limits CSV exports to 20 per hour per user (item 7)', async () => {
    const u = await signIn();
    const org = await createOrg([[u.userId, 'admin']]);
    const csvOf = (who: { cookie: string }, o: string): request.Test =>
      http().get(`/v1/orgs/${o}/activity.csv`).set('Cookie', who.cookie);
    for (let i = 0; i < 20; i++) await csvOf(u, org).expect(200);
    const res = await csvOf(u, org).expect(429);
    expect(res.body.statusCode).toBe(429);
    // per user: another member is not affected
    await csvOf(admin, orgId).expect(200);
  });
});
