import { Global, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { getDataSourceToken, TypeOrmModule } from '@nestjs/typeorm';
import request from 'supertest';
import type { DataSource, EntityManager } from 'typeorm';
import type { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { IConfigurationService } from '@/config/configuration.service.interface';
import { CacheModule } from '@/datasources/cache/cache.module';
import { LoggingService } from '@/logging/logging.interface';
import { ActivityModule } from '@/modules/org/activity/activity.module';
import { AddressBookModule } from '@/modules/org/address-book/address-book.module';
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

const ADDR = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const ADDR2 = '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359';
const ADDR3 = '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB';

describe('org address book', () => {
  let db: OrgTestDb;
  let app: NestExpressApplication;
  let sql: DataSource;
  let ipSeq = 0;
  let orgA: string;
  let orgB: string;
  let admin: { cookie: string; userId: string };
  let member: { cookie: string; userId: string };
  let adminB: { cookie: string; userId: string };

  const nextIp = (): string =>
    `10.4.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;
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
    const match = /org_session=([^;]+)/.exec(
      [res.headers['set-cookie']].flat().join(';'),
    );
    if (!match) throw new Error('no org_session cookie');
    return { cookie: `org_session=${match[1]}`, userId: res.body.user.id };
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

  // contacts are under FORCE RLS: the test seeds through the same app login
  const asOrg = <T>(
    org: string,
    fn: (em: EntityManager) => Promise<T>,
  ): Promise<T> =>
    sql.transaction(async (em) => {
      await em.query(`SELECT set_config('app.org_id', $1, true)`, [org]);
      return fn(em);
    });

  const seed = (
    org: string,
    name: string,
    address: string,
    chainIds = ['1'],
    tags: Array<string> = [],
  ): Promise<string> =>
    asOrg(org, async (em) => {
      const [{ id }] = await em.query(
        `INSERT INTO contacts (org_id, name, address, chain_ids, tags) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [org, name, address, chainIds, tags],
      );
      return id;
    });

  const events = async (
    type: string,
  ): Promise<Array<{ payload: Record<string, unknown> }>> =>
    sql.query(
      `SELECT * FROM activity_events WHERE type = $1 ORDER BY created_at`,
      [type],
    );

  const write = (
    method: 'post' | 'patch' | 'delete',
    path: string,
    who: { cookie: string },
    body?: object,
  ): request.Test =>
    http()
      [method](`/v1/orgs/${path}`)
      .set('Cookie', who.cookie)
      .set('X-Org-Request', '1')
      .send(body);
  const get = (path: string, who: { cookie: string }): request.Test =>
    http().get(`/v1/orgs/${path}`).set('Cookie', who.cookie);
  const listOf = async (
    path: string,
    who: { cookie: string },
  ): Promise<Array<{ id: string; name: string; address: string }>> =>
    (await get(path, who).expect(200)).body;
  const upload = (
    org: string,
    who: { cookie: string },
    csv: string,
  ): request.Test =>
    http()
      .post(`/v1/orgs/${org}/contacts/import`)
      .set('Cookie', who.cookie)
      .set('X-Org-Request', '1')
      .attach('file', Buffer.from(csv), 'book.csv');

  beforeAll(async () => {
    db = await createOrgTestDb();
    const owner = db.owner();
    await owner.initialize();
    await runOrgMigrations(owner, db.appUser);
    await owner.destroy();

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
        ActivityModule,
        AddressBookModule,
      ],
      providers: [
        { provide: APP_FILTER, useClass: GlobalErrorFilter },
        { provide: APP_FILTER, useClass: ZodErrorFilter },
        ...ORG_APP_GUARDS,
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureOrgApp(app);
    await app.init();
    sql = moduleRef.get<DataSource>(getDataSourceToken(ORG_DATA_SOURCE), {
      strict: false,
    });

    admin = await signIn();
    member = await signIn();
    adminB = await signIn();
    orgA = await createOrg([
      [admin.userId, 'admin'],
      [member.userId, 'member'],
    ]);
    orgB = await createOrg([[adminB.userId, 'admin']]);
    // fresh strong auth for the admins (the 2FA flow itself is covered elsewhere)
    await sql.query(
      `UPDATE sessions SET last_strong_auth_at = now() WHERE user_id = ANY($1)`,
      [[admin.userId, adminB.userId]],
    );
  });

  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  beforeEach(async () => {
    for (const org of [orgA, orgB]) {
      await asOrg(org, async (em) => {
        await em.query(`DELETE FROM contact_requests`);
        await em.query(`DELETE FROM contacts`);
      });
    }
    await sql.query(`DELETE FROM activity_events`);
  });

  it('lets a member request a change but not write directly', async () => {
    await write('post', `${orgA}/contacts`, member, {
      name: 'Bob',
      address: ADDR,
      chainIds: ['1'],
    }).expect(403);
    const res = await write('post', `${orgA}/contact-requests`, member, {
      action: 'create',
      payload: { name: 'Bob', address: ADDR.toLowerCase(), chainIds: ['1'] },
    }).expect(201);
    expect(res.body).toMatchObject({ status: 'pending', action: 'create' });
    // members cannot decide either
    await write(
      'post',
      `${orgA}/contact-requests/${res.body.id}/approve`,
      member,
    ).expect(403);
    const [ev] = await events('contact_request.created');
    expect(ev.payload).toEqual({
      name: 'Bob',
      address: ADDR,
      action: 'create',
    });
    expect(await get(`${orgA}/contacts`, member).expect(200)).toHaveProperty(
      'body',
      [],
    );
  });

  it('requires fresh strong auth for direct writes', async () => {
    await sql.query(
      `UPDATE sessions SET last_strong_auth_at = NULL WHERE user_id = $1`,
      [admin.userId],
    );
    try {
      await write('post', `${orgA}/contacts`, admin, {
        name: 'Bob',
        address: ADDR,
        chainIds: ['1'],
      }).expect(403);
    } finally {
      await sql.query(
        `UPDATE sessions SET last_strong_auth_at = now() WHERE user_id = $1`,
        [admin.userId],
      );
    }
  });

  it('applies an approved update request atomically', async () => {
    const id = await seed(orgA, 'Old', ADDR);
    const req = await write('post', `${orgA}/contact-requests`, member, {
      action: 'update',
      contactId: id,
      payload: { name: 'New', tags: ['Ops'] },
    }).expect(201);
    const ok = await write(
      'post',
      `${orgA}/contact-requests/${req.body.id}/approve`,
      admin,
    ).expect(200);
    expect(ok.body).toMatchObject({
      status: 'approved',
      decidedBy: admin.userId,
    });
    const list = await get(`${orgA}/contacts`, member).expect(200);
    expect(list.body).toEqual([
      expect.objectContaining({
        id,
        name: 'New',
        address: ADDR,
        tags: ['ops'],
      }),
    ]);
    expect(await events('contact.updated')).toHaveLength(1);
    const [approved] = await events('contact_request.approved');
    expect(approved.payload).toEqual({
      name: 'New',
      address: ADDR,
      action: 'update',
    });

    // all or nothing: an address clash fails the approval and leaves no trace
    await seed(orgA, 'Other', ADDR2);
    const bad = await write('post', `${orgA}/contact-requests`, member, {
      action: 'update',
      contactId: id,
      payload: { name: 'Changed', address: ADDR2 },
    }).expect(201);
    await write(
      'post',
      `${orgA}/contact-requests/${bad.body.id}/approve`,
      admin,
    ).expect(409);
    const after = await get(
      `${orgA}/contact-requests?status=pending`,
      admin,
    ).expect(200);
    expect((after.body as Array<{ id: string }>).map((r) => r.id)).toEqual([
      bad.body.id,
    ]);
    const names = (await listOf(`${orgA}/contacts`, admin)).map((c) => c.name);
    expect(names).toEqual(['New', 'Other']);
    expect(await events('contact_request.approved')).toHaveLength(1);
    expect(await events('contact.updated')).toHaveLength(1);
  });

  it('applies approved create and delete requests and records a rejection', async () => {
    const created = await write('post', `${orgA}/contact-requests`, member, {
      action: 'create',
      payload: { name: 'Carol', address: ADDR3, chainIds: ['1', '10'] },
    }).expect(201);
    await write(
      'post',
      `${orgA}/contact-requests/${created.body.id}/approve`,
      admin,
    ).expect(200);
    const [carol] = (await get(`${orgA}/contacts`, admin).expect(200)).body;
    expect(carol).toMatchObject({ name: 'Carol', chainIds: ['1', '10'] });

    const del = await write('post', `${orgA}/contact-requests`, member, {
      action: 'delete',
      contactId: carol.id,
    }).expect(201);
    await write(
      'post',
      `${orgA}/contact-requests/${del.body.id}/approve`,
      admin,
    ).expect(200);
    expect((await get(`${orgA}/contacts`, admin).expect(200)).body).toEqual([]);
    expect(await events('contact.deleted')).toHaveLength(1);

    const rej = await write('post', `${orgA}/contact-requests`, member, {
      action: 'create',
      payload: { name: 'Dan', address: ADDR2, chainIds: ['1'] },
    }).expect(201);
    await write(
      'post',
      `${orgA}/contact-requests/${rej.body.id}/reject`,
      admin,
    ).expect(200);
    expect((await events('contact_request.rejected'))[0].payload).toEqual({
      name: 'Dan',
      address: ADDR2,
      action: 'create',
    });
    expect((await get(`${orgA}/contacts`, admin).expect(200)).body).toEqual([]);
  });

  it('rejects deciding an already decided request with 409', async () => {
    const req = await write('post', `${orgA}/contact-requests`, member, {
      action: 'create',
      payload: { name: 'Bob', address: ADDR, chainIds: ['1'] },
    }).expect(201);
    const path = `${orgA}/contact-requests/${req.body.id}`;
    await write('post', `${path}/approve`, admin).expect(200);
    await write('post', `${path}/approve`, admin).expect(409);
    await write('post', `${path}/reject`, admin).expect(409);
    expect(
      await get(`${orgA}/contacts`, admin).then((r) => r.body),
    ).toHaveLength(1);
  });

  it('rejects a request that points at another org contact', async () => {
    const foreign = await seed(orgB, 'Secret', ADDR);
    for (const action of ['update', 'delete']) {
      await write('post', `${orgA}/contact-requests`, member, {
        action,
        contactId: foreign,
        payload: { name: 'x' },
      }).expect(404);
    }
    expect(await sql.query(`SELECT 1 FROM contact_requests`)).toHaveLength(0);
  });

  it('answers 404 for a contact id of another org, and RLS hides rows without an org', async () => {
    const foreign = await seed(orgB, 'Secret', ADDR);
    await write('patch', `${orgA}/contacts/${foreign}`, admin, {
      name: 'x',
    }).expect(404);
    await write('delete', `${orgA}/contacts/${foreign}`, admin).expect(404);
    // org B's own admin still sees it, untouched
    expect(
      (await get(`${orgB}/contacts`, adminB).expect(200)).body[0].name,
    ).toBe('Secret');
    expect((await get(`${orgA}/contacts`, admin).expect(200)).body).toEqual([]);
    // a member of A on B's path gets 404 too
    await get(`${orgB}/contacts`, member).expect(404);
    // no app.org_id set: FORCE RLS leaves the app login with zero rows
    expect(await sql.query(`SELECT 1 FROM contacts`)).toHaveLength(0);
  });

  it('imports a Safe CSV and reports created, updated and invalid lines', async () => {
    await seed(orgA, 'Old name', ADDR, ['1']);
    const csv = [
      'address,name,chainId',
      `${ADDR},Renamed,10`,
      `${ADDR2.toLowerCase()},Dave,1`,
      `${ADDR2},Dave,137`,
      'nope,Eve,1',
      `${ADDR3},,1`,
    ].join('\n');
    const res = await upload(orgA, admin, csv).expect(200);
    expect(res.body).toEqual({
      created: 1,
      updated: 1,
      skipped: [
        { line: 5, reason: 'Invalid address' },
        { line: 6, reason: expect.stringContaining('Name') },
      ],
    });
    const byAddr = Object.fromEntries(
      (await listOf(`${orgA}/contacts`, admin)).map((c) => [c.address, c]),
    );
    expect(byAddr[ADDR]).toMatchObject({
      name: 'Renamed',
      chainIds: ['1', '10'],
    });
    expect(byAddr[ADDR2]).toMatchObject({
      name: 'Dave',
      chainIds: ['1', '137'],
    });
    expect((await events('contact.imported'))[0].payload).toEqual({
      created: 1,
      updated: 1,
    });
    await upload(orgA, member, csv).expect(403);
    await http()
      .post(`/v1/orgs/${orgA}/contacts/import`)
      .set('Cookie', admin.cookie)
      .set('X-Org-Request', '1')
      .attach('file', Buffer.alloc(1024 * 1024 + 1, 'a'), 'big.csv')
      .expect(413);
  });

  it('caps contacts at 1000 per org', async () => {
    await asOrg(orgA, (em) =>
      em.query(
        `INSERT INTO contacts (org_id, name, address, chain_ids)
         SELECT $1, 'c' || n, '0x' || lpad(to_hex(n), 40, '0'), '{1}' FROM generate_series(1, 1000) n`,
        [orgA],
      ),
    );
    const res = await write('post', `${orgA}/contacts`, admin, {
      name: 'One too many',
      address: ADDR,
      chainIds: ['1'],
    }).expect(409);
    expect(res.body.code).toBe('contact_limit');
    const imp = await upload(
      orgA,
      admin,
      `address,name,chainId\n${ADDR},X,1`,
    ).expect(200);
    expect(imp.body.created).toBe(0);
    expect(imp.body.skipped).toHaveLength(1);
    // another org is unaffected
    await write('post', `${orgB}/contacts`, adminB, {
      name: 'Fine',
      address: ADDR,
      chainIds: ['1'],
    }).expect(201);
  });

  it('rejects a duplicate address and bad input', async () => {
    const body = { name: 'Bob', address: ADDR, chainIds: ['1'] };
    await write('post', `${orgA}/contacts`, admin, body).expect(201);
    await write('post', `${orgA}/contacts`, admin, {
      ...body,
      address: ADDR.toLowerCase(),
    }).expect(409);
    await write('post', `${orgA}/contacts`, admin, {
      ...body,
      address: 'x',
    }).expect(400);
    await write('post', `${orgA}/contacts`, admin, {
      ...body,
      chainIds: [],
    }).expect(400);
    await write('post', `${orgA}/contacts`, admin, {
      ...body,
      name: 'n'.repeat(65),
      address: ADDR2,
    }).expect(400);
  });

  it('exports CSV with formula-like names neutralised', async () => {
    await seed(orgA, '=HYPERLINK("http://evil")', ADDR, ['1', '10']);
    await seed(orgA, '@cmd', ADDR2, ['1']);
    const res = await get(`${orgA}/contacts.csv`, member).expect(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const lines = res.text.trim().split('\n');
    expect(lines[0]).toBe('address,name,chainId,tags');
    expect(res.text).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(res.text).toContain(`'@cmd`);
    expect(res.text).not.toMatch(/,=HYPERLINK/);
    expect(lines).toHaveLength(4);
    expect(await events('export.downloaded')).toHaveLength(1);
    expect((await events('export.downloaded'))[0].payload).toEqual({
      what: 'contacts',
    });
    await get(`${orgB}/contacts.csv`, member).expect(404);
  });

  it('filters by search, tag and chainId and returns checksummed addresses', async () => {
    await seed(orgA, 'Alice 100%', ADDR.toLowerCase(), ['1'], ['team']);
    await seed(orgA, 'Bob', ADDR2.toLowerCase(), ['10'], ['vendor', 'team']);
    const names = async (qs: string): Promise<Array<string>> =>
      (await listOf(`${orgA}/contacts${qs}`, member)).map((c) => c.name);
    expect(await names('')).toEqual(['Alice 100%', 'Bob']);
    expect(await names('?search=ali')).toEqual(['Alice 100%']);
    expect(await names(`?search=${ADDR2.slice(2, 10).toLowerCase()}`)).toEqual([
      'Bob',
    ]);
    expect(await names('?search=%25')).toEqual(['Alice 100%']);
    expect(await names('?search=_')).toEqual([]);
    expect(await names('?tag=VENDOR')).toEqual(['Bob']);
    expect(await names('?tag=team')).toEqual(['Alice 100%', 'Bob']);
    expect(await names('?chainId=10')).toEqual(['Bob']);
    expect(await names('?chainId=1&tag=team')).toEqual(['Alice 100%']);
    const all = await listOf(`${orgA}/contacts`, member);
    expect(all.map((c) => c.address)).toEqual([ADDR, ADDR2]);
  });
});
