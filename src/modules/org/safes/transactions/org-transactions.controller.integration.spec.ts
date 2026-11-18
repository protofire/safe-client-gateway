import { randomUUID } from 'node:crypto';
import { Global, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { getDataSourceToken, TypeOrmModule } from '@nestjs/typeorm';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import type { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';
import { getAddress, numberToHex, type Address } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { IConfigurationService } from '@/config/configuration.service.interface';
import {
  CacheModule,
  type RedisClientType,
} from '@/datasources/cache/cache.module';
import { LoggingService } from '@/logging/logging.interface';
import { IChainsRepository } from '@/modules/chains/domain/chains.repository.interface';
import { IDataDecoderRepository } from '@/modules/data-decoder/domain/v2/data-decoder.repository.interface';
import { confirmationBuilder } from '@/modules/safe/domain/entities/__tests__/multisig-transaction-confirmation.builder';
import type { MultisigTransaction } from '@/modules/safe/domain/entities/multisig-transaction.entity';
import { ISafeRepository } from '@/modules/safe/domain/safe.repository.interface';
import { MultisigTransactionMapper } from '@/modules/transactions/routes/mappers/multisig-transactions/multisig-transaction.mapper';
import { ActivityLog } from '@/modules/org/activity/activity-log.service';
import { listenForTests } from '@/modules/org/auth/__tests__/auth-test-app';
import {
  ORG_REDIS,
  OrgKeyPrefix,
  type OrgRedisClient,
} from '@/modules/org/auth/nonce.store';
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
import {
  LIST_SAFE_TIMEOUT_MS,
  LinkedSafesService,
} from '@/modules/org/safes/linked-safes.service';
import { OverviewService } from '@/modules/org/safes/overview.service';
import { OrgTransactionsController } from '@/modules/org/safes/transactions/org-transactions.controller';
import {
  OrgTransactionsService,
  TRANSACTIONS_BUDGET,
  TRANSACTIONS_WINDOW,
} from '@/modules/org/safes/transactions/org-transactions.service';
import {
  T0,
  executed,
  settingsData,
} from '@/modules/org/safes/transactions/__tests__/model';
import { IBalancesRepository } from '@/modules/balances/domain/balances.repository.interface';
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

const MAINNET = '1';
const POLYGON = '137';
const SEPOLIA = '11155111';
const BASE_SEPOLIA = '84532';
const TESTNETS = new Set([SEPOLIA, BASE_SEPOLIA]);

const addr = (n: number): Address => getAddress(numberToHex(n, { size: 20 }));
const SAFE_A = addr(0xa1);
const SAFE_B = addr(0xb2);
const SAFE_C = addr(0xc3);
const OTHER_OWNER = addr(0x0e);

/** In-memory tx-service: queued and executed multisig transactions per (chain, Safe). */
const store = new Map<string, Array<MultisigTransaction>>();
const slow = new Set<string>();
const at = (chainId: string, address: string): string =>
  `${chainId}:${address.toLowerCase()}`;
const txsOf = (chainId: string, address: string): Array<MultisigTransaction> =>
  store.get(at(chainId, address)) ?? [];
const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

let me: Address;
const safeRepo = {
  isSafe: jest.fn(),
  getSafe: jest.fn(),
  clearSafe: jest.fn(),
  getTransactionQueueBySubmission: jest.fn(),
  getMultisigTransactions: jest.fn(),
};
const chainsRepo = { getChain: jest.fn() };
const decoder = { getDecodedData: jest.fn() };
const mapper = { mapTransaction: jest.fn() };
const unreadable = new Set<string>();

function installTxService(): void {
  safeRepo.getSafe.mockImplementation(
    ({ chainId, address }: { chainId: string; address: Address }) => {
      if (slow.has(at(chainId, address))) return never();
      if (unreadable.has(at(chainId, address))) {
        return Promise.reject(new Error('tx-service down'));
      }
      return Promise.resolve({
        address,
        nonce: 0,
        threshold: 2,
        owners: [me, OTHER_OWNER],
      });
    },
  );
  safeRepo.getTransactionQueueBySubmission.mockImplementation(
    ({ chainId, safe }: { chainId: string; safe: { address: Address } }) => {
      const limit = 100;
      const queued = txsOf(chainId, safe.address)
        .filter((tx) => !tx.isExecuted)
        .sort(
          (a, b) => b.submissionDate.getTime() - a.submissionDate.getTime(),
        );
      return Promise.resolve({
        count: queued.length,
        next: queued.length > limit ? 'next' : null,
        previous: null,
        results: queued.slice(0, limit),
      });
    },
  );
  safeRepo.getMultisigTransactions.mockImplementation(
    (q: {
      chainId: string;
      safeAddress: Address;
      executed: boolean;
      executionDateLte?: string;
      nonceLt?: number;
      limit: number;
      offset: number;
    }) => {
      if (slow.has(at(q.chainId, q.safeAddress))) return never();
      if (unreadable.has(at(q.chainId, q.safeAddress))) {
        return Promise.reject(new Error('tx-service down'));
      }
      const lte =
        q.executionDateLte === undefined
          ? null
          : Date.parse(q.executionDateLte);
      const rows = txsOf(q.chainId, q.safeAddress)
        .filter((tx) => tx.isExecuted === q.executed)
        .filter(
          (tx) =>
            lte === null ||
            (tx.executionDate !== null && tx.executionDate.getTime() <= lte),
        )
        .filter((tx) => q.nonceLt === undefined || tx.nonce < q.nonceLt)
        .sort((a, b) => b.nonce - a.nonce);
      return Promise.resolve({
        count: rows.length,
        next: q.offset + q.limit < rows.length ? 'next' : null,
        previous: null,
        results: rows.slice(q.offset, q.offset + q.limit),
      });
    },
  );
}

const signedByMe = (): MultisigTransaction['confirmations'] => [
  confirmationBuilder().with('owner', me).build(),
];

let hashSeq = 0x7000;
/** A queued transaction submitted at T0 + `sec`. */
function queued(
  chainId: string,
  safe: Address,
  nonce: number,
  sec: number,
  extra: Partial<MultisigTransaction> = {},
): MultisigTransaction {
  const tx = executed(
    { id: '', chainId, address: safe, label: null },
    nonce,
    null,
    {
      isExecuted: false,
      isSuccessful: null,
      executor: null,
      submissionDate: new Date((T0 + sec) * 1000),
      confirmationsRequired: 2,
      confirmations: [],
      safeTxHash: numberToHex(++hashSeq, { size: 32 }),
      ...extra,
    },
  );
  store.set(at(chainId, safe), [...txsOf(chainId, safe), tx]);
  return tx;
}
/** An executed transaction at T0 + `sec`. */
function done(
  chainId: string,
  safe: Address,
  nonce: number,
  sec: number,
  extra: Partial<MultisigTransaction> = {},
): MultisigTransaction {
  const tx = executed(
    { id: '', chainId, address: safe, label: null },
    nonce,
    T0 + sec,
    { safeTxHash: numberToHex(++hashSeq, { size: 32 }), ...extra },
  );
  store.set(at(chainId, safe), [...txsOf(chainId, safe), tx]);
  return tx;
}

type Row = {
  id: string;
  linkedSafeId: string;
  chainId: string;
  safeTxHash: string;
  kind: string;
  awaitingMe: boolean;
  transaction: unknown;
};
type ListBody = {
  items: Array<Row>;
  nextCursor: string | null;
  searchedUntil: string | null;
  counts: { queued: number; awaitingMe: number; complete: boolean } | null;
  complete: boolean;
  unavailableSafeIds: Array<string>;
  truncatedSafeIds: Array<string>;
};

describe('org transactions', () => {
  let db: OrgTestDb;
  let app: NestExpressApplication;
  let sql: DataSource;
  let ipSeq = 0;

  type User = { cookie: string; userId: string; wallet: Address };
  let orgA: string;
  let orgB: string;
  let admin: User;
  let adminB: User;

  const nextIp = (): string =>
    `10.4.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;
  const http = (): ReturnType<typeof request> => request(app.getHttpServer());

  async function signIn(): Promise<User> {
    const account = privateKeyToAccount(generatePrivateKey());
    const body = (
      await http()
        .get('/v1/orgs/auth/nonce')
        .set('X-Forwarded-For', nextIp())
        .expect(200)
    ).body as { nonce: string };
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
    chainId = MAINNET,
  ): Promise<string> => {
    safeRepo.isSafe.mockResolvedValue(true);
    const res = await http()
      .post(`/v1/orgs/${org}/safes`)
      .set('Cookie', u.cookie)
      .set('X-Org-Request', '1')
      .send({ chainId, address })
      .expect(201);
    return res.body.id;
  };

  const list = (
    query: Record<string, string | Array<string>>,
    u: User = admin,
    org: string = orgA,
  ): request.Test =>
    http()
      .get(`/v1/orgs/${org}/transactions`)
      .query(query)
      .set('Cookie', u.cookie);
  const counts = (
    query: Record<string, string | Array<string>> = {},
    u: User = admin,
    org: string = orgA,
  ): request.Test =>
    http()
      .get(`/v1/orgs/${org}/transactions/counts`)
      .query(query)
      .set('Cookie', u.cookie);

  /** Follows nextCursor to the end; returns every page. */
  async function pages(
    query: Record<string, string | Array<string>>,
  ): Promise<Array<ListBody>> {
    const out: Array<ListBody> = [];
    let cursor: string | null = null;
    do {
      const res: request.Response = await list(
        cursor ? { ...query, cursor } : query,
      ).expect(200);
      const body = res.body as ListBody;
      out.push(body);
      cursor = body.nextCursor;
    } while (cursor !== null && out.length < 20);
    return out;
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
      controllers: [LinkedSafesController, OrgTransactionsController],
      providers: [
        OrgTransaction,
        ActivityLog,
        FieldEncryptionService,
        LinkedSafesService,
        OverviewService,
        OrgTransactionsService,
        // spec §9: W = 2 exercises the frontier rule and refills
        { provide: TRANSACTIONS_WINDOW, useValue: 2 },
        { provide: TRANSACTIONS_BUDGET, useValue: { safeMs: 300 } },
        { provide: LIST_SAFE_TIMEOUT_MS, useValue: 200 },
        { provide: ISafeRepository, useValue: safeRepo },
        { provide: IBalancesRepository, useValue: {} },
        { provide: IChainsRepository, useValue: chainsRepo },
        { provide: IDataDecoderRepository, useValue: decoder },
        { provide: MultisigTransactionMapper, useValue: mapper },
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
    adminB = await signIn();
    me = admin.wallet;
    orgA = await createOrg([[admin, 'admin']]);
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
    // each test gets a fresh 60/min allowance
    await app
      .get<OrgRedisClient>(ORG_REDIS, { strict: false })
      .del(`${CACHE_PREFIX}ratelimit:transactions:user:${admin.userId}`);
    store.clear();
    slow.clear();
    unreadable.clear();
    installTxService();
    chainsRepo.getChain.mockImplementation((chainId: string) =>
      Promise.resolve({ chainId, isTestnet: TESTNETS.has(chainId) }),
    );
    decoder.getDecodedData.mockResolvedValue(null);
    mapper.mapTransaction.mockImplementation(
      (_chainId: string, tx: MultisigTransaction) =>
        Promise.resolve({ id: `multisig_${tx.safe}_${tx.safeTxHash}` }),
    );
  });

  describe('access', () => {
    it('answers 403 without safes.view on both endpoints', async () => {
      const u = await signIn();
      const org = await createOrg([
        [adminB, 'admin'],
        [u, 'member'],
      ]);
      const owner = db.owner();
      await owner.initialize();
      try {
        const [{ id }]: Array<{ id: string }> = await owner.query(
          `INSERT INTO roles (org_id, key, name, permissions)
           VALUES ($1, 'no-safes', 'No Safes', ARRAY['org.view']) RETURNING id`,
          [org],
        );
        await owner.query(
          `UPDATE role_bindings SET role_id = $3
            WHERE member_id = (SELECT id FROM members WHERE org_id = $1 AND user_id = $2)`,
          [org, u.userId, id],
        );
      } finally {
        await owner.destroy();
      }
      await list({ tab: 'queue' }, u, org).expect(403);
      await counts({}, u, org).expect(403);
    });

    it('answers 404 for a linkedSafeId of another org on both endpoints', async () => {
      await link(orgA, admin, SAFE_A);
      const foreign = await link(orgB, adminB, SAFE_B);
      queued(MAINNET, SAFE_B, 1, 10);
      done(MAINNET, SAFE_B, 0, 5);
      for (const tab of ['queue', 'history']) {
        await list({ tab, linkedSafeId: foreign }).expect(404);
      }
      await counts({ linkedSafeId: foreign }).expect(404);
      expect(safeRepo.getTransactionQueueBySubmission).not.toHaveBeenCalled();
      expect(safeRepo.getMultisigTransactions).not.toHaveBeenCalled();
    });

    it('a member of another org gets 404', async () => {
      await list({ tab: 'queue' }, adminB, orgA).expect(404);
    });

    it('rejects a bad query with 400', async () => {
      await list({}).expect(400);
      await list({ tab: 'queue', kind: 'swap' }).expect(400);
      await list({ tab: 'queue', limit: '51' }).expect(400);
      await list({ tab: 'queue', chainId: '01' }).expect(400);
      await list({ tab: 'queue', linkedSafeId: 'nope' }).expect(400);
      await list({ tab: 'queue', cursor: 'x'.repeat(513) }).expect(400);
      await list({ tab: 'queue', cursor: '!!' }).expect(400);
    });
  });

  describe('queue', () => {
    it('maps rows, marks awaitingMe and conflicts, and keeps a row whose mapping throws with transaction null', async () => {
      const id = await link(orgA, admin, SAFE_A);
      const mine = queued(MAINNET, SAFE_A, 1, 30);
      queued(MAINNET, SAFE_A, 1, 20, { confirmations: [] });
      queued(MAINNET, SAFE_A, 2, 10, { confirmations: signedByMe() });
      mapper.mapTransaction.mockImplementation(
        (_c: string, tx: MultisigTransaction) =>
          tx.safeTxHash === mine.safeTxHash
            ? Promise.reject(new Error('Invalid safeTxHash'))
            : Promise.resolve({ id: 'mapped' }),
      );
      const body = (await list({ tab: 'queue' }).expect(200)).body as ListBody;
      expect(body.items.map((r) => [r.awaitingMe, r.transaction])).toEqual([
        [true, null],
        [true, { id: 'mapped' }],
        [false, { id: 'mapped' }],
      ]);
      expect(body.items[0]).toMatchObject({
        type: 'multisig',
        id: `multisig_${SAFE_A}_${mine.safeTxHash}`,
        linkedSafeId: id,
        chainId: MAINNET,
        conflict: true,
        status: 'awaiting_confirmations',
      });
      expect(body).toMatchObject({
        nextCursor: null,
        searchedUntil: null,
        counts: { queued: 3, awaitingMe: 2, complete: true },
        complete: true,
        unavailableSafeIds: [],
        truncatedSafeIds: [],
      });
      expect(mapper.mapTransaction).toHaveBeenCalledWith(
        MAINNET,
        expect.objectContaining({ safeTxHash: mine.safeTxHash }),
        expect.objectContaining({ address: SAFE_A }),
        null,
      );
    });

    it('filters by kind, mine, linkedSafeId and chainId; counts ignore kind and mine', async () => {
      const a = await link(orgA, admin, SAFE_A);
      const b = await link(orgA, admin, SAFE_B, POLYGON);
      queued(MAINNET, SAFE_A, 1, 40, {
        to: SAFE_A,
        data: settingsData,
        value: '0',
      });
      queued(MAINNET, SAFE_A, 2, 30);
      queued(POLYGON, SAFE_B, 1, 20, { confirmations: signedByMe() });
      const ids = (body: ListBody): Array<string> =>
        body.items.map((r) => `${r.linkedSafeId}:${r.kind}`);

      let res = await list({ tab: 'queue', kind: 'settings' }).expect(200);
      expect(ids(res.body as ListBody)).toEqual([`${a}:settings`]);
      expect(res.body.counts).toEqual({
        queued: 3,
        awaitingMe: 2,
        complete: true,
      });
      res = await list({ tab: 'queue', kind: ['settings', 'transfer'] });
      expect(ids(res.body as ListBody)).toEqual([
        `${a}:settings`,
        `${a}:transfer`,
        `${b}:transfer`,
      ]);
      res = await list({ tab: 'queue', mine: 'true' }).expect(200);
      expect(ids(res.body as ListBody)).toEqual([
        `${a}:settings`,
        `${a}:transfer`,
      ]);
      expect(res.body.counts.queued).toBe(3);
      res = await list({ tab: 'queue', linkedSafeId: b }).expect(200);
      expect(ids(res.body as ListBody)).toEqual([`${b}:transfer`]);
      expect(res.body.counts).toEqual({
        queued: 1,
        awaitingMe: 0,
        complete: true,
      });
      res = await list({ tab: 'queue', chainId: [MAINNET] }).expect(200);
      expect(ids(res.body as ListBody)).toEqual([
        `${a}:settings`,
        `${a}:transfer`,
      ]);

      expect((await counts().expect(200)).body).toEqual({
        queued: 3,
        awaitingMe: 2,
        complete: true,
      });
      expect(
        (await counts({ chainId: POLYGON, kind: 'settings', mine: 'true' }))
          .body,
      ).toEqual({ queued: 1, awaitingMe: 0, complete: true });
      expect((await counts({ linkedSafeId: a })).body).toEqual({
        queued: 2,
        awaitingMe: 2,
        complete: true,
      });
    });

    it('applies the network default: testnets out unless every Safe is on one; chainId overrides it', async () => {
      const test1 = await link(orgA, admin, SAFE_A, SEPOLIA);
      queued(SEPOLIA, SAFE_A, 1, 10);
      // only testnet Safes: they are shown
      let res = await list({ tab: 'queue' }).expect(200);
      expect((res.body as ListBody).items.map((r) => r.linkedSafeId)).toEqual([
        test1,
      ]);

      const main = await link(orgA, admin, SAFE_B, MAINNET);
      queued(MAINNET, SAFE_B, 1, 5);
      res = await list({ tab: 'queue' }).expect(200);
      expect((res.body as ListBody).items.map((r) => r.linkedSafeId)).toEqual([
        main,
      ]);
      expect((await counts()).body.queued).toBe(1);

      res = await list({ tab: 'queue', chainId: SEPOLIA }).expect(200);
      expect((res.body as ListBody).items.map((r) => r.linkedSafeId)).toEqual([
        test1,
      ]);
      expect((await counts({ chainId: [SEPOLIA, MAINNET] })).body.queued).toBe(
        2,
      );
    });

    it('decides the network default over every linked Safe, not over linkedSafeId', async () => {
      const test1 = await link(orgA, admin, SAFE_A, SEPOLIA);
      await link(orgA, admin, SAFE_B, MAINNET);
      queued(SEPOLIA, SAFE_A, 1, 10);
      queued(MAINNET, SAFE_B, 1, 5);

      let res = await list({ tab: 'queue', linkedSafeId: test1 }).expect(200);
      expect((res.body as ListBody).items).toEqual([]);
      expect((res.body as ListBody).counts?.queued).toBe(0);
      expect((await counts({ linkedSafeId: test1 })).body.queued).toBe(0);
      res = await list({
        tab: 'queue',
        linkedSafeId: test1,
        chainId: SEPOLIA,
      }).expect(200);
      expect((res.body as ListBody).items.map((r) => r.linkedSafeId)).toEqual([
        test1,
      ]);
    });

    it('a chain whose config cannot be read is unavailable, not guessed; the other testnets are listed', async () => {
      const ok = await link(orgA, admin, SAFE_A, SEPOLIA);
      const lost = await link(orgA, admin, SAFE_B, BASE_SEPOLIA);
      queued(SEPOLIA, SAFE_A, 1, 10);
      queued(BASE_SEPOLIA, SAFE_B, 1, 5);
      done(SEPOLIA, SAFE_A, 0, 3);
      done(BASE_SEPOLIA, SAFE_B, 0, 2);
      chainsRepo.getChain.mockImplementation((chainId: string) =>
        chainId === BASE_SEPOLIA
          ? Promise.reject(new Error('config down'))
          : Promise.resolve({ chainId, isTestnet: true }),
      );

      safeRepo.getSafe.mockClear();
      safeRepo.getMultisigTransactions.mockClear();
      for (const tab of ['queue', 'history']) {
        const body = (await list({ tab }).expect(200)).body as ListBody;
        expect(body.items.map((r) => r.linkedSafeId)).toEqual([ok]);
        expect(body.unavailableSafeIds).toEqual([lost]);
        expect(body.complete).toBe(false);
      }
      expect((await counts()).body).toEqual({
        queued: 1,
        awaitingMe: 1,
        complete: false,
      });
      for (const read of [safeRepo.getSafe, safeRepo.getMultisigTransactions]) {
        expect(read).not.toHaveBeenCalledWith(
          expect.objectContaining({ chainId: BASE_SEPOLIA }),
        );
      }
    });

    it('pages across 3 Safes on 2 chains without skipping or repeating', async () => {
      await link(orgA, admin, SAFE_A);
      await link(orgA, admin, SAFE_B);
      await link(orgA, admin, SAFE_C, POLYGON);
      const all = [
        queued(MAINNET, SAFE_A, 1, 60),
        queued(POLYGON, SAFE_C, 1, 50),
        queued(MAINNET, SAFE_B, 1, 40),
        queued(MAINNET, SAFE_A, 2, 30),
        // same second on two chains: chain 1 first
        queued(POLYGON, SAFE_C, 2, 20),
        queued(MAINNET, SAFE_B, 2, 20),
        queued(MAINNET, SAFE_A, 3, 10),
      ];
      const got = await pages({ tab: 'queue', limit: '2' });
      expect(got.map((p) => p.items.length)).toEqual([2, 2, 2, 1]);
      expect(got.flatMap((p) => p.items.map((r) => r.safeTxHash))).toEqual(
        [all[0], all[1], all[2], all[3], all[5], all[4], all[6]].map(
          (tx) => tx.safeTxHash,
        ),
      );
    });

    it('marks the 101st queued transaction as truncated, and counts incomplete', async () => {
      const id = await link(orgA, admin, SAFE_A);
      for (let n = 0; n < 101; n++) queued(MAINNET, SAFE_A, n, n);
      const body = (await list({ tab: 'queue', limit: '50' }).expect(200))
        .body as ListBody;
      expect(body.truncatedSafeIds).toEqual([id]);
      expect(body.complete).toBe(true);
      expect(body.counts).toEqual({
        queued: 100,
        awaitingMe: 100,
        complete: false,
      });
      expect((await counts()).body.complete).toBe(false);
    });

    it('does not flag exactly 100 queued transactions', async () => {
      await link(orgA, admin, SAFE_A);
      for (let n = 0; n < 100; n++) queued(MAINNET, SAFE_A, n, n);
      const body = (await list({ tab: 'queue' }).expect(200)).body as ListBody;
      expect(body.truncatedSafeIds).toEqual([]);
      expect(body.counts?.complete).toBe(true);
    });

    it('reports an unreadable Safe and one timing out: complete false, counts incomplete, others still listed', async () => {
      const ok = await link(orgA, admin, SAFE_A);
      const down = await link(orgA, admin, SAFE_B);
      const late = await link(orgA, admin, SAFE_C);
      queued(MAINNET, SAFE_A, 1, 10);
      unreadable.add(at(MAINNET, SAFE_B));
      slow.add(at(MAINNET, SAFE_C));
      const started = Date.now();
      const body = (await list({ tab: 'queue' }).expect(200)).body as ListBody;
      expect(Date.now() - started).toBeLessThan(3000);
      expect(body.items.map((r) => r.linkedSafeId)).toEqual([ok]);
      expect(body.complete).toBe(false);
      expect([...body.unavailableSafeIds].sort()).toEqual([down, late].sort());
      expect(body.counts?.complete).toBe(false);
      expect((await counts()).body).toEqual({
        queued: 1,
        awaitingMe: 1,
        complete: false,
      });
    });
  });

  describe('history', () => {
    it('pages across 3 Safes on 2 chains with W = 2 in the total order, each row once', async () => {
      await link(orgA, admin, SAFE_A);
      await link(orgA, admin, SAFE_B);
      await link(orgA, admin, SAFE_C, POLYGON);
      const rows = [
        done(MAINNET, SAFE_A, 4, 100),
        // same second on three Safes: chain 1 (A, B), then chain 137
        done(POLYGON, SAFE_C, 3, 90),
        done(MAINNET, SAFE_B, 3, 90),
        done(MAINNET, SAFE_A, 3, 90),
        done(MAINNET, SAFE_A, 2, 70),
        done(POLYGON, SAFE_C, 2, 60, { isSuccessful: false }),
        done(MAINNET, SAFE_B, 2, 50),
        done(MAINNET, SAFE_A, 1, 40),
        done(POLYGON, SAFE_C, 1, 30),
        done(MAINNET, SAFE_B, 1, 20),
      ];
      const expected = [0, 3, 2, 1, 4, 5, 6, 7, 8, 9].map(
        (i) => rows[i].safeTxHash,
      );
      for (const limit of ['1', '3']) {
        const got = await pages({ tab: 'history', limit });
        expect(got.flatMap((p) => p.items.map((r) => r.safeTxHash))).toEqual(
          expected,
        );
        expect(got.at(-1)?.nextCursor).toBeNull();
        expect(got.every((p) => p.counts === null && p.complete)).toBe(true);
      }
      const first = (await list({ tab: 'history', limit: '3' })).body;
      expect(first.searchedUntil).toEqual(expect.any(String));
      expect(first.items[0]).toMatchObject({
        status: 'executed',
        awaitingMe: false,
        conflict: false,
        transaction: { id: `multisig_${SAFE_A}_${rows[0].safeTxHash}` },
      });
    });

    it('filters by kind and Safe', async () => {
      const a = await link(orgA, admin, SAFE_A);
      const b = await link(orgA, admin, SAFE_B, POLYGON);
      done(MAINNET, SAFE_A, 3, 50);
      const settings = done(MAINNET, SAFE_A, 2, 40, {
        to: SAFE_A,
        data: settingsData,
        value: '0',
      });
      done(MAINNET, SAFE_A, 1, 30);
      const bRow = done(POLYGON, SAFE_B, 1, 20);
      const all = (q: Record<string, string>): Promise<Array<string>> =>
        pages({ tab: 'history', ...q }).then((ps) =>
          ps.flatMap((p) => p.items.map((r) => r.safeTxHash)),
        );
      expect(await all({ kind: 'settings' })).toEqual([settings.safeTxHash]);
      expect(await all({ linkedSafeId: b })).toEqual([bRow.safeTxHash]);
      expect(await all({ chainId: POLYGON })).toEqual([bRow.safeTxHash]);
      expect((await all({ linkedSafeId: a })).length).toBe(3);
    });

    it('a Safe timing out: complete false, the others still page', async () => {
      const ok = await link(orgA, admin, SAFE_A);
      const late = await link(orgA, admin, SAFE_B);
      done(MAINNET, SAFE_A, 1, 10);
      slow.add(at(MAINNET, SAFE_B));
      const body = (await list({ tab: 'history' }).expect(200))
        .body as ListBody;
      expect(body.items.map((r) => r.linkedSafeId)).toEqual([ok]);
      expect(body.complete).toBe(false);
      expect(body.unavailableSafeIds).toEqual([late]);
    });
  });

  describe('cursor', () => {
    it('answers 409 cursor_stale after a link or an unlink between pages', async () => {
      await link(orgA, admin, SAFE_A);
      queued(MAINNET, SAFE_A, 1, 20);
      queued(MAINNET, SAFE_A, 2, 10);
      done(MAINNET, SAFE_A, 1, 5);
      done(MAINNET, SAFE_A, 0, 4);
      const q = await list({ tab: 'queue', limit: '1' }).expect(200);
      const h = await list({ tab: 'history', limit: '1' }).expect(200);
      expect(q.body.nextCursor).not.toBeNull();
      expect(h.body.nextCursor).not.toBeNull();

      const added = await link(orgA, admin, SAFE_B);
      for (const [tab, cursor] of [
        ['queue', q.body.nextCursor],
        ['history', h.body.nextCursor],
      ]) {
        const res = await list({ tab, limit: '1', cursor }).expect(409);
        expect(res.body.code).toBe('cursor_stale');
      }
      // another tab is another scope
      await list({ tab: 'history', cursor: q.body.nextCursor }).expect(409);

      const again = await list({ tab: 'queue', limit: '1' }).expect(200);
      await http()
        .delete(`/v1/orgs/${orgA}/safes/${added}`)
        .set('Cookie', admin.cookie)
        .set('X-Org-Request', '1')
        .expect(204);
      const res = await list({
        tab: 'queue',
        limit: '1',
        cursor: again.body.nextCursor,
      }).expect(409);
      expect(res.body.code).toBe('cursor_stale');
    });

    it('answers 404 on Load more for a linkedSafeId unlinked between pages', async () => {
      const id = await link(orgA, admin, SAFE_A);
      queued(MAINNET, SAFE_A, 1, 20);
      queued(MAINNET, SAFE_A, 2, 10);
      const first = await list({
        tab: 'queue',
        limit: '1',
        linkedSafeId: id,
      }).expect(200);
      await http()
        .delete(`/v1/orgs/${orgA}/safes/${id}`)
        .set('Cookie', admin.cookie)
        .set('X-Org-Request', '1')
        .expect(204);
      await list({
        tab: 'queue',
        limit: '1',
        linkedSafeId: id,
        cursor: first.body.nextCursor,
      }).expect(404);
    });
  });

  it('limits the list and the counts together to 60 per minute per user', async () => {
    const u = await signIn();
    const org = await createOrg([[u, 'admin']]);
    for (let i = 0; i < 30; i++) {
      await list({ tab: 'queue' }, u, org).expect(200);
      await counts({}, u, org).expect(200);
    }
    await counts({}, u, org).expect(429);
    await list({ tab: 'history' }, u, org).expect(429);
    await list({ tab: 'queue' }).expect(200);
  });
});
