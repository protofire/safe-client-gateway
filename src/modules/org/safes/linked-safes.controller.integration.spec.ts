import { randomUUID } from 'node:crypto';
import { Global, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { getDataSourceToken, TypeOrmModule } from '@nestjs/typeorm';
import request from 'supertest';
import { listenForTests } from '@/modules/org/auth/__tests__/auth-test-app';
import type { DataSource } from 'typeorm';
import type { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';
import { getAddress, type Address } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { IConfigurationService } from '@/config/configuration.service.interface';
import {
  CacheModule,
  type RedisClientType,
} from '@/datasources/cache/cache.module';
import { LoggingService } from '@/logging/logging.interface';
import { DataSourceError } from '@/domain/errors/data-source.error';
import { IBalancesRepository } from '@/modules/balances/domain/balances.repository.interface';
import { IChainsRepository } from '@/modules/chains/domain/chains.repository.interface';
import { ActivityLog } from '@/modules/org/activity/activity-log.service';
import { OrgKeyPrefix } from '@/modules/org/auth/nonce.store';
import { OrgAuthModule } from '@/modules/org/auth/org-auth.module';
import { FieldEncryptionService } from '@/modules/org/crypto/field-encryption.service';
import {
  createOrgTestDb,
  type OrgTestDb,
} from '@/modules/org/db/__tests__/org-test-db';
import { ORG_DATA_SOURCE } from '@/modules/org/db/org-data-source';
import { OrgTransaction } from '@/modules/org/db/org-transaction';
import { PermissionsModule } from '@/modules/org/permissions/permissions.module';
import { LinkedSafesController } from '@/modules/org/safes/linked-safes.controller';
import { LinkedSafesService } from '@/modules/org/safes/linked-safes.service';
import {
  OVERVIEW_SAFE_TIMEOUT_MS,
  OverviewService,
} from '@/modules/org/safes/overview.service';
import { ISafeRepository } from '@/modules/safe/domain/safe.repository.interface';
import { ORG_APP_GUARDS } from '@/org-app.module';
import { configureOrgApp } from '@/org-main';
import { runOrgMigrations } from '@/org-migrate';
import { GlobalErrorFilter } from '@/routes/common/filters/global-error.filter';
import { ZodErrorFilter } from '@/routes/common/filters/zod-error.filter';

const APP_URL = 'https://app.example.com';
// Redis DB 2 is shared across worktrees: a private prefix, never flushDb()
const CACHE_PREFIX = `org:test:${randomUUID()}:`;

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

// Gateway repositories are mocked: no network
const safeRepo = {
  isSafe: jest.fn(),
  getSafe: jest.fn(),
  clearSafe: jest.fn(),
  getTransactionQueue: jest.fn(),
};
const balancesRepo = { getBalances: jest.fn(), getFiatCodes: jest.fn() };
const chainsRepo = { getChain: jest.fn() };

const addr = (n: number): Address =>
  getAddress(`0x${n.toString(16).padStart(40, '0')}`);
const SAFE_A = addr(0xa1);
const SAFE_B = addr(0xb2);

type Tx = {
  safeTxHash: string;
  nonce: number;
  confirmationsRequired: number;
  confirmations: Array<{ owner: Address }> | null;
};
const tx = (nonce: number, owners: Array<Address> = []): Tx => ({
  safeTxHash: `0x${nonce.toString(16).padStart(64, '0')}`,
  nonce,
  confirmationsRequired: 2,
  confirmations: owners.map((owner) => ({ owner })),
});
type Page = {
  count: number;
  next: string | null;
  previous: null;
  results: Array<Tx>;
};
/** Offset-paged queue of `total` transactions */
const queueOf =
  (total: number, build: (n: number) => Tx = (n) => tx(n)) =>
  ({ limit, offset }: { limit: number; offset: number }): Promise<Page> =>
    Promise.resolve({
      count: total,
      next: offset + limit < total ? 'next' : null,
      previous: null,
      results: Array.from(
        { length: Math.max(0, Math.min(limit, total - offset)) },
        (_, i) => build(offset + i),
      ),
    });

describe('linked Safes and overview', () => {
  let db: OrgTestDb;
  let app: NestExpressApplication;
  let sql: DataSource;
  let ipSeq = 0;

  type User = { cookie: string; userId: string; wallet: Address };
  let orgA: string;
  let orgB: string;
  let admin: User; // admin of A
  let member: User; // member of A
  let adminB: User; // admin of B

  const nextIp = (): string =>
    `10.3.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;
  const http = (): ReturnType<typeof request> => request(app.getHttpServer());
  const post = (
    path: string,
    u: User,
  ): ReturnType<ReturnType<typeof request>['post']> =>
    http().post(path).set('Cookie', u.cookie).set('X-Org-Request', '1');

  async function signIn(): Promise<User> {
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
      wallet: account.address,
    };
  }

  function createOrg(
    users: Array<[User, 'admin' | 'member']>,
  ): Promise<string> {
    return sql.transaction(async (em) => {
      const [{ id }] = await em.query(
        `INSERT INTO organizations (name) VALUES ('org') RETURNING id`,
      );
      for (const [u, role] of users) {
        const [{ id: memberId }] = await em.query(
          `INSERT INTO members (org_id, user_id, status) VALUES ($1, $2, 'active') RETURNING id`,
          [id, u.userId],
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

  const link = async (
    org: string,
    u: User,
    address: Address,
    chainId = '1',
  ): Promise<string> => {
    safeRepo.isSafe.mockResolvedValue(true);
    const res = await post(`/v1/orgs/${org}/safes`, u)
      .send({ chainId, address })
      .expect(201);
    return res.body.id;
  };

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
      controllers: [LinkedSafesController],
      providers: [
        OrgTransaction,
        ActivityLog,
        FieldEncryptionService,
        LinkedSafesService,
        OverviewService,
        { provide: OVERVIEW_SAFE_TIMEOUT_MS, useValue: 300 },
        { provide: ISafeRepository, useValue: safeRepo },
        { provide: IBalancesRepository, useValue: balancesRepo },
        { provide: IChainsRepository, useValue: chainsRepo },
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

    admin = await signIn();
    member = await signIn();
    adminB = await signIn();
    orgA = await createOrg([
      [admin, 'admin'],
      [member, 'member'],
    ]);
    orgB = await createOrg([[adminB, 'admin']]);
  });

  afterAll(async () => {
    const redis = app?.get<RedisClientType>('RedisClient', { strict: false });
    if (redis?.isReady) {
      for await (const keys of redis.scanIterator({
        MATCH: `${CACHE_PREFIX}*`,
      })) {
        if (keys.length > 0) await redis.del(keys);
      }
    }
    await app?.close();
    await db?.drop();
  });

  beforeEach(async () => {
    jest.resetAllMocks();
    await sql.query(`DELETE FROM linked_safes`);
    balancesRepo.getFiatCodes.mockResolvedValue(['EUR', 'USD']);
    balancesRepo.getBalances.mockResolvedValue([]);
    chainsRepo.getChain.mockResolvedValue({ chainId: '1' });
    safeRepo.getSafe.mockResolvedValue({ owners: [], threshold: 2 });
    safeRepo.getTransactionQueue.mockImplementation(queueOf(0));
  });

  it('rejects linking an address that is not a Safe (422)', async () => {
    safeRepo.isSafe.mockResolvedValue(false);
    await post(`/v1/orgs/${orgA}/safes`, admin)
      .send({ chainId: '1', address: SAFE_A })
      .expect(422);
    const [{ count }] = await sql.query(
      `SELECT count(*)::int FROM linked_safes`,
    );
    expect(count).toBe(0);
  });

  it('links a Safe, records safe.linked in the activity log, and rejects a duplicate with 409', async () => {
    safeRepo.isSafe.mockResolvedValue(true);
    const res = await post(`/v1/orgs/${orgA}/safes`, admin)
      .send({ chainId: '1', address: SAFE_A.toLowerCase(), label: 'Ops' })
      .expect(201);
    expect(res.body).toEqual({
      id: expect.any(String),
      chainId: '1',
      address: SAFE_A,
      label: 'Ops',
    });
    const events = await sql.query(
      `SELECT type, payload, target_id FROM activity_events WHERE org_id = $1 AND type = 'safe.linked'`,
      [orgA],
    );
    expect(events).toEqual([
      {
        type: 'safe.linked',
        payload: { chainId: '1', address: SAFE_A, label: 'Ops' },
        target_id: res.body.id,
      },
    ]);
    const dup = await post(`/v1/orgs/${orgA}/safes`, admin)
      .send({ chainId: '1', address: SAFE_A })
      .expect(409);
    expect(dup.body.code).toBe('already_linked');
  });

  it('lets two orgs link the same Safe', async () => {
    await link(orgA, admin, SAFE_A);
    await link(orgB, adminB, SAFE_A);
    const rows = await sql.query(
      `SELECT org_id FROM linked_safes WHERE address = $1`,
      [SAFE_A],
    );
    expect(
      (rows as Array<{ org_id: string }>).map((r) => r.org_id).sort(),
    ).toEqual([orgA, orgB].sort());
  });

  it('refuses the 51st Safe with 409 safe_limit', async () => {
    await sql.query(
      `INSERT INTO linked_safes (org_id, chain_id, address)
       SELECT $1, '1', '0x' || lpad(to_hex(g), 40, '0') FROM generate_series(1000, 1049) g`,
      [orgA],
    );
    safeRepo.isSafe.mockResolvedValue(true);
    const res = await post(`/v1/orgs/${orgA}/safes`, admin)
      .send({ chainId: '1', address: SAFE_A })
      .expect(409);
    expect(res.body.code).toBe('safe_limit');
  });

  it('serialises concurrent links at the limit', async () => {
    await sql.query(
      `INSERT INTO linked_safes (org_id, chain_id, address)
       SELECT $1, '1', '0x' || lpad(to_hex(g), 40, '0') FROM generate_series(1000, 1048) g`,
      [orgA],
    );
    safeRepo.isSafe.mockResolvedValue(true);
    const statuses = await Promise.all(
      [0xc1, 0xc2, 0xc3].map(
        async (n) =>
          (
            await post(`/v1/orgs/${orgA}/safes`, admin).send({
              chainId: '1',
              address: addr(n),
            })
          ).status,
      ),
    );
    expect(statuses.sort()).toEqual([201, 409, 409]);
  });

  it('a member cannot link (403)', async () => {
    safeRepo.isSafe.mockResolvedValue(true);
    await post(`/v1/orgs/${orgA}/safes`, member)
      .send({ chainId: '1', address: SAFE_A })
      .expect(403);
  });

  it('answers 422 unknown_chain when the chain is not in the config service, and rejects leading zeros', async () => {
    safeRepo.isSafe.mockRejectedValue(new DataSourceError('Not found', 404));
    const res = await post(`/v1/orgs/${orgA}/safes`, admin)
      .send({ chainId: '999999', address: SAFE_A })
      .expect(422);
    expect(res.body.code).toBe('unknown_chain');
    await post(`/v1/orgs/${orgA}/safes`, admin)
      .send({ chainId: '01', address: SAFE_A })
      .expect(400);
  });

  it('unlink requires strong auth', async () => {
    const id = await link(orgA, admin, SAFE_A);
    await sql.query(
      `UPDATE sessions SET last_strong_auth_at = now() - interval '2 hours' WHERE user_id = $1`,
      [admin.userId],
    );
    const res = await http()
      .delete(`/v1/orgs/${orgA}/safes/${id}`)
      .set('Cookie', admin.cookie)
      .set('X-Org-Request', '1')
      .expect(403);
    expect(res.body.code).toBe('step_up_required');
    const [{ count }] = await sql.query(
      `SELECT count(*)::int FROM linked_safes`,
    );
    expect(count).toBe(1);

    await sql.query(
      `UPDATE sessions SET last_strong_auth_at = now() WHERE user_id = $1`,
      [admin.userId],
    );
    await http()
      .delete(`/v1/orgs/${orgA}/safes/${id}`)
      .set('Cookie', admin.cookie)
      .set('X-Org-Request', '1')
      .expect(204);
    const events = await sql.query(
      `SELECT payload FROM activity_events WHERE org_id = $1 AND type = 'safe.unlinked'`,
      [orgA],
    );
    expect(events).toEqual([{ payload: { chainId: '1', address: SAFE_A } }]);
  });

  it('answers 404 for a linked Safe id of another org', async () => {
    const idB = await link(orgB, adminB, SAFE_A);
    await http()
      .delete(`/v1/orgs/${orgA}/safes/${idB}`)
      .set('Cookie', admin.cookie)
      .set('X-Org-Request', '1')
      .expect(404);
    await http()
      .delete(`/v1/orgs/${orgA}/safes/not-a-uuid`)
      .set('Cookie', admin.cookie)
      .set('X-Org-Request', '1')
      .expect(404);
    // B's list is untouched, and A's member cannot read B at all
    await http()
      .get(`/v1/orgs/${orgB}/safes`)
      .set('Cookie', admin.cookie)
      .expect(404);
    const [{ count }] = await sql.query(
      `SELECT count(*)::int FROM linked_safes`,
    );
    expect(count).toBe(1);
  });

  describe('list', () => {
    it('marks iAmSigner from current owners, not from history', async () => {
      await link(orgA, admin, SAFE_A);
      await link(orgA, admin, SAFE_B);
      safeRepo.getSafe.mockImplementation(({ address }) =>
        Promise.resolve({
          owners: address === SAFE_A ? [admin.wallet, addr(9)] : [addr(9)],
          threshold: 2,
        }),
      );
      const first = await http()
        .get(`/v1/orgs/${orgA}/safes`)
        .set('Cookie', admin.cookie)
        .expect(200);
      expect(
        Object.fromEntries(
          (first.body as Array<{ address: string; iAmSigner: boolean }>).map(
            (s) => [s.address, s.iAmSigner],
          ),
        ),
      ).toEqual({ [SAFE_A]: true, [SAFE_B]: false });

      // the wallet was removed on-chain: nothing stored, so it flips
      safeRepo.getSafe.mockResolvedValue({ owners: [addr(9)], threshold: 2 });
      const second = await http()
        .get(`/v1/orgs/${orgA}/safes`)
        .set('Cookie', admin.cookie)
        .expect(200);
      expect(
        (second.body as Array<{ iAmSigner: boolean }>).every(
          (s) => !s.iAmSigner,
        ),
      ).toBe(true);
    });
  });

  describe('overview', () => {
    const overview = (
      fiat = 'USD',
    ): ReturnType<ReturnType<typeof request>['get']> =>
      http()
        .get(`/v1/orgs/${orgA}/overview?fiat=${fiat}`)
        .set('Cookie', admin.cookie);

    it('lists a queued tx in awaitingMySignature only when my wallet is an owner that has not confirmed', async () => {
      const id = await link(orgA, admin, SAFE_A);
      safeRepo.getSafe.mockResolvedValue({
        owners: [admin.wallet, addr(9)],
        threshold: 2,
      });
      safeRepo.getTransactionQueue.mockImplementation(
        queueOf(3, (n) => {
          if (n === 0) return tx(n, [addr(9)]); // I have not signed
          if (n === 1) return tx(n, [admin.wallet.toLowerCase() as Address]); // I signed
          return tx(n, []);
        }),
      );
      let res = await overview().expect(200);
      expect(res.body.safes[0]).toMatchObject({
        id,
        queuedCount: 3,
        awaitingMySignature: 2,
        queueTruncated: false,
      });
      expect(
        (res.body.awaitingMySignature as Array<{ nonce: number }>).map(
          (a) => a.nonce,
        ),
      ).toEqual([0, 2]);
      expect(res.body.awaitingMySignature[0]).toEqual({
        linkedSafeId: id,
        chainId: '1',
        safeTxHash: tx(0).safeTxHash,
        nonce: 0,
        confirmations: 1,
        threshold: 2,
      });

      // not an owner any more: nothing awaits me
      safeRepo.getSafe.mockResolvedValue({ owners: [addr(9)], threshold: 2 });
      res = await overview().expect(200);
      expect(res.body.awaitingMySignature).toEqual([]);
      expect(res.body.safes[0].awaitingMySignature).toBe(0);
    });

    it('traverses queue pages up to 100 and sets queueTruncated', async () => {
      await link(orgA, admin, SAFE_A);
      safeRepo.getTransactionQueue.mockImplementation(queueOf(250));
      const res = await overview().expect(200);
      expect(res.body.safes[0]).toMatchObject({
        queuedCount: 100,
        queueTruncated: true,
      });
      expect(safeRepo.getTransactionQueue).toHaveBeenCalledTimes(5);
      expect(
        safeRepo.getTransactionQueue.mock.calls.map((c) => c[0].offset),
      ).toEqual([0, 20, 40, 60, 80]);
    });

    it('does not flag exactly 100 queued transactions as truncated', async () => {
      await link(orgA, admin, SAFE_A);
      safeRepo.getTransactionQueue.mockImplementation(queueOf(100));
      const res = await overview().expect(200);
      expect(res.body.safes[0]).toMatchObject({
        queuedCount: 100,
        queueTruncated: false,
      });
    });

    it('returns other Safes when one fails: complete=false, unavailableSafeIds, totals.partial', async () => {
      const okId = await link(orgA, admin, SAFE_A);
      const badId = await link(orgA, admin, SAFE_B);
      balancesRepo.getBalances.mockImplementation(({ safeAddress }) => {
        if (safeAddress === SAFE_B)
          return Promise.reject(new Error('tx-service down'));
        return Promise.resolve([
          { fiatBalance: '10.5' },
          { fiatBalance: '0.25' },
          { fiatBalance: null },
        ]);
      });
      const res = await overview().expect(200);
      expect(res.body.complete).toBe(false);
      expect(res.body.unavailableSafeIds).toEqual([badId]);
      expect(res.body.totals).toEqual({ fiatTotal: '10.75', partial: true });
      const byId = Object.fromEntries(
        (res.body.safes as Array<{ id: string }>).map((s) => [s.id, s]),
      );
      expect(byId[okId]).toMatchObject({ fiatTotal: '10.75' });
      expect(byId[badId]).toMatchObject({
        error: 'unavailable',
        fiatTotal: '0',
      });
    });

    it('reports complete=true with exact decimal totals when every Safe answers', async () => {
      await link(orgA, admin, SAFE_A);
      await link(orgA, admin, SAFE_B);
      balancesRepo.getBalances.mockResolvedValue([
        { fiatBalance: '0.1' },
        { fiatBalance: '0.2' },
      ]);
      const res = await overview().expect(200);
      expect(res.body).toMatchObject({
        complete: true,
        unavailableSafeIds: [],
        totals: { fiatTotal: '0.6', partial: false },
      });
    });

    it('accepts the fiat code case-insensitively and rejects unknown codes', async () => {
      await link(orgA, admin, SAFE_A);
      await overview('usd').expect(200);
      expect(balancesRepo.getBalances).toHaveBeenCalledWith(
        expect.objectContaining({ fiatCode: 'USD' }),
      );
      await overview('xyz').expect(400);
    });

    it('does not 400 when the fiat code list is empty or unavailable', async () => {
      await link(orgA, admin, SAFE_A);
      balancesRepo.getFiatCodes.mockResolvedValue([]);
      await overview('usd').expect(200);
      expect(balancesRepo.getBalances).toHaveBeenCalledWith(
        expect.objectContaining({ fiatCode: 'USD' }),
      );
      balancesRepo.getFiatCodes.mockRejectedValue(new Error('provider down'));
      await overview('usd').expect(200);
    });

    it('excludes transactions that already have enough confirmations (2-of-3)', async () => {
      await link(orgA, admin, SAFE_A);
      safeRepo.getSafe.mockResolvedValue({
        owners: [admin.wallet, addr(8), addr(9)],
        threshold: 2,
      });
      safeRepo.getTransactionQueue.mockImplementation(
        queueOf(2, (n) =>
          n === 0 ? tx(n, [addr(8), addr(9)]) : tx(n, [addr(8)]),
        ),
      );
      const res = await overview().expect(200);
      expect(
        (res.body.awaitingMySignature as Array<{ nonce: number }>).map(
          (a) => a.nonce,
        ),
      ).toEqual([1]);
      expect(res.body.safes[0]).toMatchObject({
        queuedCount: 2,
        awaitingMySignature: 1,
      });
    });

    it('marks a Safe unavailable after the per-Safe deadline and returns the others', async () => {
      const okId = await link(orgA, admin, SAFE_A);
      const slowId = await link(orgA, admin, SAFE_B);
      balancesRepo.getBalances.mockImplementation(({ safeAddress }) =>
        safeAddress === SAFE_B
          ? new Promise(() => undefined)
          : Promise.resolve([{ fiatBalance: '1' }]),
      );
      const started = Date.now();
      const res = await overview().expect(200);
      expect(Date.now() - started).toBeLessThan(3000);
      expect(res.body.unavailableSafeIds).toEqual([slowId]);
      expect(res.body.complete).toBe(false);
      expect(res.body.totals).toEqual({ fiatTotal: '1', partial: true });
      expect(
        (res.body.safes as Array<{ id: string }>).find((s) => s.id === okId),
      ).toMatchObject({ fiatTotal: '1' });
    });

    it('a member of another org gets 404', async () => {
      await http()
        .get(`/v1/orgs/${orgA}/overview`)
        .set('Cookie', adminB.cookie)
        .expect(404);
    });
  });

  it('limits the overview to 30 per minute per user (item 7)', async () => {
    const u = await signIn();
    const org = await createOrg([[u, 'admin']]);
    const overviewOf = (who: User, o: string): request.Test =>
      http().get(`/v1/orgs/${o}/overview`).set('Cookie', who.cookie);
    for (let i = 0; i < 30; i++) await overviewOf(u, org).expect(200);
    await overviewOf(u, org).expect(429);
    await overviewOf(admin, orgA).expect(200);
  });
});
