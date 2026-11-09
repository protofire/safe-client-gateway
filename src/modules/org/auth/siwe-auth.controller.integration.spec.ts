import { Controller, Get, Global, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { getDataSourceToken, TypeOrmModule } from '@nestjs/typeorm';
import { createClient } from 'redis';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import type { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';
import type { Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { IConfigurationService } from '@/config/configuration.service.interface';
import { CacheModule } from '@/datasources/cache/cache.module';
import { LoggingService } from '@/logging/logging.interface';
import { RequireStrongAuth } from '@/modules/org/auth/decorators';
import { OrgAuthModule } from '@/modules/org/auth/org-auth.module';
import { Clock } from '@/modules/org/common/clock';
import { sha256Hex } from '@/modules/org/crypto/hashing';
import {
  createOrgTestDb,
  type OrgTestDb,
} from '@/modules/org/db/__tests__/org-test-db';
import { ORG_DATA_SOURCE } from '@/modules/org/db/org-data-source';
import { configureOrgApp } from '@/org-main';
import { ORG_APP_GUARDS } from '@/org-app.module';
import { PermissionsModule } from '@/modules/org/permissions/permissions.module';
import { runOrgMigrations } from '@/org-migrate';
import { GlobalErrorFilter } from '@/routes/common/filters/global-error.filter';
import { ZodErrorFilter } from '@/routes/common/filters/zod-error.filter';

const APP_URL = 'https://app.example.com';
const REDIS_URL = 'redis://127.0.0.1:6379/2';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// Strong-auth route stand-in; real ones arrive with Tasks 5–8
@Controller({ path: 'orgs/strong-test', version: '1' })
class StrongTestController {
  @Get()
  @RequireStrongAuth()
  get(): { ok: true } {
    return { ok: true };
  }
}

const config: Record<string, unknown> = {
  'org.trustProxyHops': 1,
  'org.publicAppUrl': APP_URL,
  'express.jsonLimit': '1mb',
  'org.session.idleTtlSeconds': 12 * 3600,
  'org.session.absoluteTtlSeconds': 7 * 24 * 3600,
  'org.session.strongAuthWindowSeconds': 30 * 60,
  'org.encryption.keys': JSON.stringify({
    current: 'v1',
    keys: { v1: randomBytes(32).toString('base64') },
  }),
  'auth.nonceTtlSeconds': 300,
  'redis.host': '127.0.0.1',
  'redis.port': '6379/2',
  'redis.connectTimeout': 10_000,
  'redis.keepAlive': 30_000,
  'redis.disableOfflineQueue': false,
  'expirationTimeInSeconds.default': 60,
  'expirationTimeInSeconds.deviatePercent': 0,
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
    {
      provide: LoggingService,
      useValue: {
        error: jest.fn(),
        warn: jest.fn(),
        info: jest.fn(),
        debug: jest.fn(),
      },
    },
  ],
  exports: [IConfigurationService, LoggingService],
})
class TestProvidersModule {}

describe('SIWE auth (org)', () => {
  let db: OrgTestDb;
  let app: NestExpressApplication;
  let sql: DataSource;
  let redis: ReturnType<typeof createClient>;
  let offsetMs = 0;
  let ipSeq = 0;
  const clock = { now: (): Date => new Date(Date.now() + offsetMs) };

  beforeAll(async () => {
    db = await createOrgTestDb();
    const owner = db.owner();
    await owner.initialize();
    await runOrgMigrations(owner, db.appUser);
    await owner.destroy();

    redis = createClient({ url: REDIS_URL });
    await redis.connect();

    const moduleRef = await Test.createTestingModule({
      imports: [
        TestProvidersModule,
        CacheModule.register('org:'),
        TypeOrmModule.forRoot({
          ...(db.app().options as PostgresConnectionOptions),
          name: ORG_DATA_SOURCE,
        }),
        OrgAuthModule,
        PermissionsModule,
      ],
      controllers: [StrongTestController],
      providers: [
        { provide: APP_FILTER, useClass: GlobalErrorFilter },
        { provide: APP_FILTER, useClass: ZodErrorFilter },
        ...ORG_APP_GUARDS,
      ],
    })
      .overrideProvider(Clock)
      .useValue(clock)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureOrgApp(app);
    await app.init();
    sql = moduleRef.get<DataSource>(getDataSourceToken(ORG_DATA_SOURCE), {
      strict: false,
    });
  });

  afterAll(async () => {
    await app?.close();
    await redis?.flushDb();
    await redis?.quit();
    await db?.drop();
  });

  beforeEach(async () => {
    offsetMs = 0;
    await redis.flushDb();
  });

  // A fresh client IP per request unless pinned, so the per-IP limit stays out of the way
  const nextIp = (): string =>
    `10.1.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;
  const http = (): ReturnType<typeof request> => request(app.getHttpServer());

  async function nonce(): Promise<string> {
    const res = await http()
      .get('/v1/orgs/auth/nonce')
      .set('X-Forwarded-For', nextIp())
      .expect(200);
    return res.body.nonce;
  }

  async function signed(
    pk: Hex,
    overrides: Partial<Parameters<typeof createSiweMessage>[0]> = {},
  ): Promise<{ message: string; signature: Hex }> {
    const account = privateKeyToAccount(pk);
    const message = createSiweMessage({
      address: account.address,
      chainId: 1,
      domain: 'app.example.com',
      nonce: overrides.nonce ?? (await nonce()),
      uri: APP_URL,
      version: '1',
      ...overrides,
    });
    return { message, signature: await account.signMessage({ message }) };
  }

  function post(path: string, ip = nextIp()): request.Test {
    return http()
      .post(path)
      .set('X-Org-Request', '1')
      .set('X-Forwarded-For', ip);
  }

  function sessionCookie(res: request.Response): string {
    const raw = [res.headers['set-cookie']].flat().join(';');
    const match = /org_session=([^;]+)/.exec(raw);
    if (!match) throw new Error('no org_session cookie');
    return `org_session=${match[1]}`;
  }

  async function signIn(pk: Hex): Promise<string> {
    const res = await post('/v1/orgs/auth/siwe')
      .send(await signed(pk))
      .expect(200);
    return sessionCookie(res);
  }

  it('signs in with a valid SIWE message and sets an HttpOnly cookie scoped to /v1/orgs', async () => {
    const pk = generatePrivateKey();
    const res = await post('/v1/orgs/auth/siwe')
      .send(await signed(pk))
      .expect(200);

    const cookie = [res.headers['set-cookie']].flat()[0];
    expect(cookie).toMatch(/^org_session=[A-Za-z0-9_-]{43};/);
    expect(cookie).toMatch(/; HttpOnly/);
    expect(cookie).toMatch(/; Secure/);
    expect(cookie).toMatch(/; SameSite=Lax/);
    expect(cookie).toMatch(/; Path=\/v1\/orgs;/);
    expect(res.body).toEqual({ user: { id: expect.any(String) } });

    const me = await http()
      .get('/v1/orgs/auth/me')
      .set('Cookie', sessionCookie(res))
      .expect(200);
    expect(me.body).toEqual({
      user: { id: res.body.user.id },
      identities: [
        {
          id: expect.any(String),
          kind: 'wallet',
          walletAddress: privateKeyToAccount(pk).address,
        },
      ],
      hasTotp: false,
      lastStrongAuthAt: expect.any(String),
    });
  });

  it('stores only the SHA-256 of the session token', async () => {
    const cookie = await signIn(generatePrivateKey());
    const token = cookie.split('=')[1];
    const rows = await sql.query(
      `SELECT count(*)::int AS n FROM sessions WHERE token_hash = $1`,
      [sha256Hex(token)],
    );
    expect(rows[0].n).toBe(1);
  });

  it('signs the same wallet into the same user twice', async () => {
    const pk = generatePrivateKey();
    const a = await post('/v1/orgs/auth/siwe').send(await signed(pk));
    const b = await post('/v1/orgs/auth/siwe').send(await signed(pk));
    expect(b.body.user.id).toBe(a.body.user.id);
  });

  it('rejects a reused nonce with 401', async () => {
    const body = await signed(generatePrivateKey());
    await post('/v1/orgs/auth/siwe').send(body).expect(200);
    await post('/v1/orgs/auth/siwe').send(body).expect(401);
  });

  it('rejects a nonce the server never issued with 401', async () => {
    const body = await signed(generatePrivateKey(), { nonce: 'abcdefgh1234' });
    await post('/v1/orgs/auth/siwe').send(body).expect(401);
  });

  it('consumes the nonce atomically: two parallel verifies of one message give one 200 and one 401', async () => {
    const body = await signed(generatePrivateKey());
    const statuses = (
      await Promise.all([
        post('/v1/orgs/auth/siwe').send(body),
        post('/v1/orgs/auth/siwe').send(body),
      ])
    )
      .map((r) => r.status)
      .sort();
    expect(statuses).toEqual([200, 401]);
  });

  it('rejects a SIWE message for another domain', async () => {
    const body = await signed(generatePrivateKey(), {
      domain: 'evil.example.com',
    });
    const res = await post('/v1/orgs/auth/siwe').send(body).expect(401);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('rejects a SIWE message whose uri is another origin', async () => {
    const body = await signed(generatePrivateKey(), {
      uri: 'https://evil.example.com',
    });
    await post('/v1/orgs/auth/siwe').send(body).expect(401);
  });

  it('rejects an expired SIWE message', async () => {
    const body = await signed(generatePrivateKey(), {
      expirationTime: new Date(Date.now() - MINUTE),
    });
    await post('/v1/orgs/auth/siwe').send(body).expect(401);
  });

  it('rejects a signature by another wallet with 401', async () => {
    const body = await signed(generatePrivateKey());
    const other = await signed(generatePrivateKey());
    await post('/v1/orgs/auth/siwe')
      .send({ message: body.message, signature: other.signature })
      .expect(401);
  });

  it('answers 422 for a malformed body', async () => {
    await post('/v1/orgs/auth/siwe').send({ message: 1 }).expect(422);
  });

  it('answers 401 without a session on /v1/orgs/auth/me', async () => {
    await http().get('/v1/orgs/auth/me').expect(401);
    await http()
      .get('/v1/orgs/auth/me')
      .set('Cookie', 'org_session=not-a-session')
      .expect(401);
  });

  it('returns 403 step_up_required on a strong-auth route 31 minutes after sign-in and 200 after step-up', async () => {
    const pk = generatePrivateKey();
    const cookie = await signIn(pk);
    await http().get('/v1/orgs/strong-test').set('Cookie', cookie).expect(200);

    offsetMs = 31 * MINUTE;
    const res = await http()
      .get('/v1/orgs/strong-test')
      .set('Cookie', cookie)
      .expect(403);
    expect(res.body).toEqual({
      statusCode: 403,
      message: expect.any(String),
      code: 'step_up_required',
      methods: ['siwe'],
    });

    await post('/v1/orgs/auth/step-up/siwe')
      .set('Cookie', cookie)
      .send(await signed(pk))
      .expect(200);
    await http().get('/v1/orgs/strong-test').set('Cookie', cookie).expect(200);
  });

  it('rejects step-up/siwe with a wallet that does not belong to the session user with 401', async () => {
    const cookie = await signIn(generatePrivateKey());
    const otherPk = generatePrivateKey();
    // a known wallet of another user, and an unknown wallet
    await signIn(otherPk);
    offsetMs = 31 * MINUTE;

    for (const pk of [otherPk, generatePrivateKey()]) {
      await post('/v1/orgs/auth/step-up/siwe')
        .set('Cookie', cookie)
        .send(await signed(pk))
        .expect(401);
    }
    await http().get('/v1/orgs/strong-test').set('Cookie', cookie).expect(403);
  });

  it('returns 403 totp_required when the user has neither a wallet nor confirmed TOTP', async () => {
    const token = 'no-factor-session-token';
    await sql.transaction(async (em) => {
      const [{ id: userId }] = await em.query(
        `INSERT INTO users DEFAULT VALUES RETURNING id`,
      );
      await em.query(
        `INSERT INTO sessions (user_id, token_hash, amr, last_strong_auth_at, expires_at, idle_expires_at)
         VALUES ($1, $2, '{oidc}', NULL, now() + interval '1 day', now() + interval '1 hour')`,
        [userId, sha256Hex(token)],
      );
    });

    const res = await http()
      .get('/v1/orgs/strong-test')
      .set('Cookie', `org_session=${token}`)
      .expect(403);
    expect(res.body).toEqual({
      statusCode: 403,
      message: expect.any(String),
      code: 'totp_required',
    });
  });

  it('revokes the session on logout so the old cookie gets 401', async () => {
    const cookie = await signIn(generatePrivateKey());
    await http().get('/v1/orgs/auth/me').set('Cookie', cookie).expect(200);

    const res = await post('/v1/orgs/auth/logout')
      .set('Cookie', cookie)
      .expect(204);
    expect([res.headers['set-cookie']].flat()[0]).toMatch(/^org_session=;/);

    await http().get('/v1/orgs/auth/me').set('Cookie', cookie).expect(401);
  });

  it('rejects POST without X-Org-Request header with 403', async () => {
    const body = await signed(generatePrivateKey());
    await http().post('/v1/orgs/auth/siwe').send(body).expect(403);
    // the nonce was not consumed by the rejected request
    await post('/v1/orgs/auth/siwe').send(body).expect(200);
  });

  it('expires a session after the idle TTL and keeps it alive with activity', async () => {
    const cookie = await signIn(generatePrivateKey());

    offsetMs = 11 * HOUR;
    await http().get('/v1/orgs/auth/me').set('Cookie', cookie).expect(200);
    // 22 h after sign-in, 11 h after the last request
    offsetMs = 22 * HOUR;
    await http().get('/v1/orgs/auth/me').set('Cookie', cookie).expect(200);
    // 12 h + 1 min of inactivity
    offsetMs = 34 * HOUR + MINUTE;
    await http().get('/v1/orgs/auth/me').set('Cookie', cookie).expect(401);
  });

  it('expires a session after the absolute TTL despite activity', async () => {
    const cookie = await signIn(generatePrivateKey());
    for (let h = 11; h < 7 * 24; h += 11) {
      offsetMs = h * HOUR;
      await http().get('/v1/orgs/auth/me').set('Cookie', cookie).expect(200);
    }
    offsetMs = 7 * 24 * HOUR + MINUTE;
    await http().get('/v1/orgs/auth/me').set('Cookie', cookie).expect(401);
  });

  it('returns 429 after 10 verify attempts per minute from one IP', async () => {
    const ip = '10.9.9.9';
    // different wallets, so only the per-IP limit can trigger
    for (let i = 0; i < 10; i++) {
      await post('/v1/orgs/auth/siwe', ip)
        .send(await signed(generatePrivateKey()))
        .expect(200);
    }
    await post('/v1/orgs/auth/siwe', ip)
      .send(await signed(generatePrivateKey()))
      .expect(429);
    // another IP is unaffected
    await post('/v1/orgs/auth/siwe')
      .send(await signed(generatePrivateKey()))
      .expect(200);
  });

  it('has no per-account limit: junk attempts naming a victim do not lock the victim out', async () => {
    const victim = generatePrivateKey();
    const junk = await signed(victim);
    // a valid signature of some other message: wrong for this one
    const { signature } = await signed(generatePrivateKey());
    for (let i = 0; i < 20; i++) {
      await post('/v1/orgs/auth/siwe')
        .send({ message: junk.message, signature })
        .expect(401);
    }
    await post('/v1/orgs/auth/siwe')
      .send(await signed(victim))
      .expect(200);
  });

  it('returns 429 after 30 nonce requests per minute from one IP', async () => {
    const ip = '10.8.8.8';
    for (let i = 0; i < 30; i++) {
      await http()
        .get('/v1/orgs/auth/nonce')
        .set('X-Forwarded-For', ip)
        .expect(200);
    }
    await http()
      .get('/v1/orgs/auth/nonce')
      .set('X-Forwarded-For', ip)
      .expect(429);
    await http()
      .get('/v1/orgs/auth/nonce')
      .set('X-Forwarded-For', nextIp())
      .expect(200);
  });

  it('stores the nonce as one expiring key and leaves nothing behind after use', async () => {
    const body = await signed(generatePrivateKey());
    const nonceValue = /Nonce: (\w+)/.exec(body.message)![1];
    const key = `org:auth:nonce:${nonceValue}`;
    expect(await redis.type(key)).toBe('string');
    const ttl = await redis.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(300);

    await post('/v1/orgs/auth/siwe').send(body).expect(200);
    // no nonce key and no cache invalidation marker left behind
    expect(await redis.keys('org:auth:nonce:*')).toEqual([]);
    expect(await redis.keys('*invalidationTimeMs*')).toEqual([]);
  });

  it('answers 503 on the nonce endpoint when the nonce cannot be stored', async () => {
    const client = app.get<{ set: () => Promise<unknown> }>('OrgRedisClient', {
      strict: false,
    });
    const spy = jest
      .spyOn(client, 'set')
      .mockRejectedValueOnce(new Error('redis down'));
    try {
      await http()
        .get('/v1/orgs/auth/nonce')
        .set('X-Forwarded-For', nextIp())
        .expect(503);
    } finally {
      spy.mockRestore();
    }
  });

  it.each([
    ['version 2', (m: string): string => m.replace('Version: 1', 'Version: 2')],
    [
      'an invalid Issued At',
      (m: string): string => m.replace(/Issued At: .*/, 'Issued At: garbage'),
    ],
    [
      'an invalid Expiration Time',
      (m: string): string => `${m}\nExpiration Time: garbage`,
    ],
    [
      'a non-checksummed address',
      (m: string): string =>
        m.replace(/0x[0-9a-fA-F]{40}/, (a) => a.toLowerCase()),
    ],
  ])('rejects a SIWE message with %s', async (_, mutate) => {
    const pk = generatePrivateKey();
    const message = mutate((await signed(pk)).message);
    const signature = await privateKeyToAccount(pk).signMessage({ message });
    await post('/v1/orgs/auth/siwe').send({ message, signature }).expect(401);
  });

  it('rejects sign-in of a user whose status is not active', async () => {
    const pk = generatePrivateKey();
    const res = await post('/v1/orgs/auth/siwe').send(await signed(pk));
    await sql.query(`UPDATE users SET status = 'deleted' WHERE id = $1`, [
      res.body.user.id,
    ]);
    await post('/v1/orgs/auth/siwe')
      .send(await signed(pk))
      .expect(401);
  });

  it('logout without a valid session still answers 204 and clears the cookie', async () => {
    for (const cookie of [undefined, 'org_session=unknown']) {
      const req = post('/v1/orgs/auth/logout');
      if (cookie) req.set('Cookie', cookie);
      const res = await req.expect(204);
      expect([res.headers['set-cookie']].flat()[0]).toMatch(/^org_session=;/);
    }
  });
});
