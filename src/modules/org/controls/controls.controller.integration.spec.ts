import { randomUUID } from 'node:crypto';
import { Global, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { getDataSourceToken, TypeOrmModule } from '@nestjs/typeorm';
import request from 'supertest';
import type { DataSource, EntityManager } from 'typeorm';
import type { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';
import { getAddress, zeroAddress, type Address } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { IConfigurationService } from '@/config/configuration.service.interface';
import {
  CacheModule,
  type RedisClientType,
} from '@/datasources/cache/cache.module';
import { LoggingService } from '@/logging/logging.interface';
import { IChainsRepository } from '@/modules/chains/domain/chains.repository.interface';
import { CsvService } from '@/modules/csv-export/csv-utils/csv.service';
import { IExportApiManager } from '@/modules/csv-export/v1/datasources/export-api.manager.interface';
import { IDelegatesV2Repository } from '@/modules/delegate/domain/v2/delegates.v2.repository.interface';
import { ActivityLog } from '@/modules/org/activity/activity-log.service';
import { listenForTests } from '@/modules/org/auth/__tests__/auth-test-app';
import { OrgKeyPrefix } from '@/modules/org/auth/nonce.store';
import { OrgAuthModule } from '@/modules/org/auth/org-auth.module';
import { ControlsController } from '@/modules/org/controls/controls.controller';
import { ControlsService } from '@/modules/org/controls/controls.service';
import {
  OrgTransactionsExportService,
  TX_EXPORT_MAX_PAGES,
  TX_EXPORT_MAX_ROWS,
} from '@/modules/org/controls/org-transactions-export.service';
import { FieldEncryptionService } from '@/modules/org/crypto/field-encryption.service';
import {
  createOrgTestDb,
  type OrgTestDb,
} from '@/modules/org/db/__tests__/org-test-db';
import { ORG_DATA_SOURCE } from '@/modules/org/db/org-data-source';
import { OrgTransaction } from '@/modules/org/db/org-transaction';
import { PermissionsModule } from '@/modules/org/permissions/permissions.module';
import { configHash } from '@/modules/org/policies/config-hash';
import { PolicyContextService } from '@/modules/org/policies/policy-context.service';
import type { PolicyRule } from '@/modules/org/policies/policy-rules';
import { OVERVIEW_SAFE_TIMEOUT_MS } from '@/modules/org/safes/overview.service';
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
const safeRepo = { getSafe: jest.fn() };
const delegatesRepo = { getDelegates: jest.fn() };
const chainsRepo = { getChain: jest.fn() };
const exportApi = { export: jest.fn() };
const exportManager = { getApi: jest.fn() };

const CHAIN = '11155111';
const CHAIN_2 = '84532';
const addr = (n: number): Address =>
  getAddress(`0x${n.toString(16).padStart(40, '0')}`);
const SAFE_A = addr(0xa1);
const SAFE_B = addr(0xb2);
const CAP_RULES: Array<PolicyRule> = [
  { kind: 'recipients_allowlist', tag: 'allowed' },
];

type ExportRow = Partial<{
  note: string | null;
  assetSymbol: string | null;
  nonce: string;
}>;
const exportRow = (
  safe: Address,
  n: number,
  over: ExportRow = {},
): Record<string, unknown> => ({
  safe,
  from: safe,
  to: addr(0xe0 + (n % 16)),
  amount: '1500000',
  assetType: 'erc20',
  assetAddress: addr(0xc0),
  assetSymbol: 'USDC',
  assetDecimals: 6,
  proposerAddress: addr(0xd1),
  proposedAt: '2026-01-02T10:00:00Z',
  executorAddress: addr(0xd2),
  executedAt: '2026-01-03T10:00:00Z',
  note: null,
  transactionHash: `0x${n.toString(16).padStart(64, '0')}`,
  contractAddress: null,
  nonce: String(n),
  ...over,
});
/** Offset-paged export of `total` rows */
const exportOf =
  (total: number, build: (n: number) => Record<string, unknown>) =>
  ({ limit, offset }: { limit: number; offset: number }): Promise<unknown> =>
    Promise.resolve({
      count: total,
      next: offset + limit < total ? 'next' : null,
      previous: null,
      results: Array.from(
        { length: Math.max(0, Math.min(limit, total - offset)) },
        (_, i) => build(offset + i),
      ),
    });

describe('Controls and org-wide transactions CSV', () => {
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
    return {
      cookie: `org_session=${match[1]}`,
      userId: res.body.user.id,
      wallet: account.address,
    };
  }

  function createOrg(users: Array<User>): Promise<string> {
    return sql.transaction(async (em) => {
      const [{ id }] = await em.query(
        `INSERT INTO organizations (name) VALUES ('org') RETURNING id`,
      );
      for (const u of users) {
        const [{ id: memberId }] = await em.query(
          `INSERT INTO members (org_id, user_id, status) VALUES ($1, $2, 'active') RETURNING id`,
          [id, u.userId],
        );
        await em.query(
          `INSERT INTO role_bindings (member_id, role_id, scope)
             SELECT $1, id, 'org' FROM roles WHERE org_id IS NULL AND key = 'admin'`,
          [memberId],
        );
      }
      return id;
    });
  }

  const asOrg = <T>(
    org: string,
    fn: (em: EntityManager) => Promise<T>,
  ): Promise<T> =>
    sql.transaction(async (em) => {
      await em.query(`SELECT set_config('app.org_id', $1, true)`, [org]);
      return fn(em);
    });

  const link = async (
    org: string,
    address: Address,
    chainId = CHAIN,
    label: string | null = null,
  ): Promise<string> =>
    (
      await sql.query(
        `INSERT INTO linked_safes (org_id, chain_id, address, label) VALUES ($1, $2, $3, $4) RETURNING id`,
        [org, chainId, address, label],
      )
    )[0].id;

  const addPolicy = (
    org: string,
    name: string,
    rules: Array<PolicyRule>,
    chainIds: Array<string> = [],
  ): Promise<string> =>
    asOrg(org, async (em) => {
      const [{ id }] = await em.query(
        `INSERT INTO policies (org_id, name) VALUES ($1, $2) RETURNING id`,
        [org, name],
      );
      const scope = { safes: [], chainIds };
      await em.query(
        `INSERT INTO policy_versions (org_id, policy_id, version, scope, rules, config_hash)
         VALUES ($1, $2, 1, $3, $4, $5)`,
        [
          org,
          id,
          JSON.stringify(scope),
          JSON.stringify(rules),
          configHash(scope, rules),
        ],
      );
      return id;
    });

  const addFinding = (
    org: string,
    linkedSafeId: string,
    address: Address,
    n: number,
    resolved = false,
  ): Promise<unknown> =>
    asOrg(org, (em) =>
      em.query(
        `INSERT INTO policy_findings (org_id, linked_safe_id, chain_id, safe_address, safe_tx_hash, nonce, evaluation_hash, violations, resolved_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'h', '[]', ${resolved ? 'now()' : 'NULL'})`,
        [org, linkedSafeId, CHAIN, address, `0x${n}`, n],
      ),
    );

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
      controllers: [ControlsController],
      providers: [
        OrgTransaction,
        ActivityLog,
        FieldEncryptionService,
        CsvService,
        ControlsService,
        OrgTransactionsExportService,
        PolicyContextService,
        { provide: OVERVIEW_SAFE_TIMEOUT_MS, useValue: 300 },
        { provide: TX_EXPORT_MAX_ROWS, useValue: 250 },
        { provide: TX_EXPORT_MAX_PAGES, useValue: 5 },
        { provide: ISafeRepository, useValue: safeRepo },
        { provide: IDelegatesV2Repository, useValue: delegatesRepo },
        { provide: IChainsRepository, useValue: chainsRepo },
        { provide: IExportApiManager, useValue: exportManager },
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
    orgA = await createOrg([admin]);
    orgB = await createOrg([adminB]);
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
    await sql.query(`DELETE FROM policy_scan_state`);
    await sql.query(`DELETE FROM linked_safes`);
    await asOrg(orgA, (em) => em.query(`DELETE FROM policies`));
    await sql.query(
      `DELETE FROM activity_events WHERE type = 'export.downloaded'`,
    );
    chainsRepo.getChain.mockResolvedValue({ contractAddresses: {} });
    safeRepo.getSafe.mockResolvedValue({
      owners: [addr(1), addr(2)],
      threshold: 2,
      guard: zeroAddress,
      modules: null,
      fallbackHandler: zeroAddress,
      version: '1.4.1',
    });
    delegatesRepo.getDelegates.mockResolvedValue({
      count: 0,
      next: null,
      previous: null,
      results: [],
    });
    exportManager.getApi.mockResolvedValue(exportApi);
    exportApi.export.mockImplementation(exportOf(0, () => ({})));
  });

  describe('GET controls', () => {
    const controls = (
      org = orgA,
      u = admin,
    ): ReturnType<ReturnType<typeof request>['get']> =>
      http().get(`/v1/orgs/${org}/controls`).set('Cookie', u.cookie);

    it('returns owners, threshold, guard, modules and proposers per linked Safe', async () => {
      const id = await link(orgA, SAFE_A, CHAIN, 'Ops');
      safeRepo.getSafe.mockResolvedValue({
        owners: [addr(1), addr(2), addr(3)],
        threshold: 2,
        guard: addr(0x91),
        modules: [addr(0x92)],
        fallbackHandler: addr(0x93),
        version: '1.3.0',
      });
      const page = (offset: number): unknown => ({
        count: 3,
        next: offset === 0 ? 'next' : null,
        previous: null,
        results:
          offset === 0
            ? [
                {
                  safe: SAFE_A,
                  delegate: addr(0x71),
                  delegator: addr(1),
                  label: 'a',
                },
                {
                  safe: SAFE_A,
                  delegate: addr(0x72),
                  delegator: addr(1),
                  label: 'b',
                },
              ]
            : [
                // same delegate, second delegator: listed once
                {
                  safe: SAFE_A,
                  delegate: addr(0x71),
                  delegator: addr(2),
                  label: 'c',
                },
              ],
      });
      delegatesRepo.getDelegates.mockImplementation(
        ({ offset }: { offset: number }) => Promise.resolve(page(offset)),
      );

      const res = await controls().expect(200);

      expect(delegatesRepo.getDelegates).toHaveBeenCalledWith(
        expect.objectContaining({ chainId: CHAIN, safeAddress: SAFE_A }),
      );
      expect(res.body).toEqual([
        {
          linkedSafeId: id,
          chainId: CHAIN,
          address: SAFE_A,
          label: 'Ops',
          version: '1.3.0',
          owners: [addr(1), addr(2), addr(3)],
          threshold: 2,
          guard: addr(0x91),
          modules: [addr(0x92)],
          fallbackHandler: addr(0x93),
          proposers: [addr(0x71), addr(0x72)],
          policies: [],
          policyStatus: 'no_policies',
          openFindings: 0,
          scanStatus: { lastSuccessAt: null, lastErrorAt: null, stale: false },
        },
      ]);
    });

    it('maps the zero guard and fallback handler to null and absent modules to []', async () => {
      await link(orgA, SAFE_A);
      const res = await controls().expect(200);
      expect(res.body[0]).toMatchObject({
        guard: null,
        fallbackHandler: null,
        modules: [],
      });
    });

    it('marks policyStatus checked_in_app_only when a policy covers the Safe', async () => {
      const covered = await link(orgA, SAFE_A, CHAIN);
      const other = await link(orgA, SAFE_B, CHAIN_2);
      const policy = await addPolicy(orgA, 'Allowlist', CAP_RULES, [CHAIN]);
      await addFinding(orgA, covered, SAFE_A, 1);
      await addFinding(orgA, covered, SAFE_A, 2);
      await addFinding(orgA, covered, SAFE_A, 3, true); // resolved: not counted

      const res = await controls().expect(200);
      const by = (id: string): Record<string, unknown> =>
        (res.body as Array<{ linkedSafeId: string }>).find(
          (s) => s.linkedSafeId === id,
        ) as Record<string, unknown>;
      expect(by(covered)).toMatchObject({
        policies: [{ id: policy, name: 'Allowlist', version: 1 }],
        policyStatus: 'checked_in_app_only',
        openFindings: 2,
      });
      expect(by(other)).toMatchObject({
        policies: [],
        policyStatus: 'no_policies',
        openFindings: 0,
      });
    });

    it('reads the org policies once per request, however many Safes are linked', async () => {
      await link(orgA, SAFE_A, CHAIN);
      await link(orgA, SAFE_B, CHAIN);
      await link(orgA, addr(0xc3), CHAIN_2);
      await addPolicy(orgA, 'P', CAP_RULES, [CHAIN]);
      const read = jest.spyOn(PolicyContextService.prototype, 'orgPolicies');
      const res = await controls().expect(200);
      expect(read).toHaveBeenCalledTimes(1);
      expect(
        (res.body as Array<{ policyStatus: string }>).map(
          (s) => s.policyStatus,
        ),
      ).toEqual(['checked_in_app_only', 'checked_in_app_only', 'no_policies']);
      read.mockRestore();
    });

    it('reports scanStatus: fresh, stale and never scanned', async () => {
      await link(orgA, SAFE_A, CHAIN);
      await addPolicy(orgA, 'P', CAP_RULES);
      // never scanned while a policy covers the Safe: stale
      let res = await controls().expect(200);
      expect(res.body[0].scanStatus).toEqual({
        lastSuccessAt: null,
        lastErrorAt: null,
        stale: true,
      });

      await sql.query(
        `INSERT INTO policy_scan_state (chain_id, address, last_success_at, last_error_at)
         VALUES ($1, $2, now() - interval '5 minutes', now() - interval '1 minute')`,
        [CHAIN, SAFE_A],
      );
      res = await controls().expect(200);
      expect(res.body[0].scanStatus).toEqual({
        lastSuccessAt: expect.stringMatching(/Z$/),
        lastErrorAt: expect.stringMatching(/Z$/),
        stale: false,
      });

      await sql.query(
        `UPDATE policy_scan_state SET last_success_at = now() - interval '31 minutes'`,
      );
      res = await controls().expect(200);
      expect(res.body[0].scanStatus.stale).toBe(true);
    });

    it('is never stale without a covering policy', async () => {
      await link(orgA, SAFE_A, CHAIN);
      await sql.query(
        `INSERT INTO policy_scan_state (chain_id, address, last_success_at)
         VALUES ($1, $2, now() - interval '3 hours')`,
        [CHAIN, SAFE_A],
      );
      const res = await controls().expect(200);
      // no covering policy: no scan timestamps either (nothing of this org is scanned)
      expect(res.body[0].scanStatus).toEqual({
        lastSuccessAt: null,
        lastErrorAt: null,
        stale: false,
      });
    });

    it('returns other Safes when one is unavailable', async () => {
      const bad = await link(orgA, SAFE_A, CHAIN);
      const good = await link(orgA, SAFE_B, CHAIN);
      safeRepo.getSafe.mockImplementation(
        ({ address }: { address: Address }) =>
          address === SAFE_A
            ? Promise.reject(new Error('tx-service down'))
            : Promise.resolve({
                owners: [addr(1)],
                threshold: 1,
                guard: zeroAddress,
                modules: [],
                fallbackHandler: zeroAddress,
                version: '1.4.1',
              }),
      );
      await addPolicy(orgA, 'P', CAP_RULES);

      const res = await controls().expect(200);
      const by = (id: string): Record<string, unknown> =>
        (res.body as Array<{ linkedSafeId: string }>).find(
          (s) => s.linkedSafeId === id,
        ) as Record<string, unknown>;
      expect(by(bad)).toMatchObject({
        error: 'unavailable',
        owners: [],
        threshold: 0,
        proposers: [],
        // database-side facts stay
        policyStatus: 'checked_in_app_only',
      });
      expect(by(good)).toMatchObject({ threshold: 1, owners: [addr(1)] });
      expect(by(good).error).toBeUndefined();
    });

    it('marks a Safe unavailable when its delegates cannot be read', async () => {
      await link(orgA, SAFE_A);
      delegatesRepo.getDelegates.mockRejectedValue(new Error('boom'));
      const res = await controls().expect(200);
      expect(res.body[0].error).toBe('unavailable');
    });

    it('answers 404 for controls of another org', async () => {
      await controls(orgA, adminB).expect(404);
      await controls(orgB, admin).expect(404);
    });
  });

  describe('GET transactions.csv', () => {
    const q = '?executedFrom=2026-01-01&executedTo=2026-03-31';
    const csv = (
      query = q,
      org = orgA,
      u = admin,
    ): ReturnType<ReturnType<typeof request>['get']> =>
      http()
        .get(`/v1/orgs/${org}/transactions.csv${query}`)
        .set('Cookie', u.cookie)
        .buffer(true)
        .parse((res, cb) => {
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (c: string) => (data += c));
          res.on('end', () => cb(null, data));
          res.on('error', () => cb(null, data));
        });
    const lines = (text: string): Array<string> => text.trim().split('\n');

    it('exports executed transactions of all linked Safes with chain and label columns', async () => {
      await link(orgA, SAFE_A, CHAIN, 'Ops');
      await link(orgA, SAFE_B, CHAIN_2, null);
      exportApi.export.mockImplementation(
        ({
          safeAddress,
          ...rest
        }: {
          safeAddress: Address;
          limit: number;
          offset: number;
        }) =>
          exportOf(safeAddress === SAFE_A ? 150 : 2, (n) =>
            exportRow(safeAddress, n),
          )(rest),
      );

      const res = await csv().expect(200);

      expect(res.headers['content-type']).toContain('text/csv');
      const rows = lines(res.body as string);
      expect(rows[0]).toBe(
        'Chain ID,Safe label,Nonce,Safe Address,From Address,To Address,Transaction Hash,Contract Address,Amount,Asset Type,Asset Symbol,Created at,Executed at,Proposer Address,Executor Address,Note,Status',
      );
      expect(rows).toHaveLength(1 + 150 + 2); // 100 + 50 and 2: paged by 100
      expect(rows[1]).toContain(`${CHAIN},Ops,0,${SAFE_A}`);
      expect(rows[1]).toContain(
        ',1.5,erc20,USDC,2026-01-02T10:00:00.000Z,2026-01-03T10:00:00.000Z,',
      );
      expect(rows[1].endsWith(',executed')).toBe(true);
      expect(rows[151]).toContain(`${CHAIN_2},,0,${SAFE_B}`);
      // the range goes to the tx-service as full timestamps; the end day is inclusive
      expect(exportApi.export).toHaveBeenCalledWith(
        expect.objectContaining({
          safeAddress: SAFE_A,
          executionDateGte: '2026-01-01T00:00:00.000Z',
          executionDateLte: '2026-03-31T23:59:59.999Z',
          limit: 100,
          offset: 100,
        }),
      );
      const events = await sql.query(
        `SELECT payload, actor_user_id FROM activity_events WHERE type = 'export.downloaded'`,
      );
      expect(events).toEqual([
        { payload: { what: 'transactions' }, actor_user_id: admin.userId },
      ]);
    });

    it('writes an unavailable row for a Safe whose export fails', async () => {
      await link(orgA, SAFE_A, CHAIN, 'Ops');
      await link(orgA, SAFE_B, CHAIN, 'Cold');
      exportApi.export.mockImplementation(
        ({
          safeAddress,
          ...rest
        }: {
          safeAddress: Address;
          limit: number;
          offset: number;
        }) =>
          safeAddress === SAFE_A
            ? Promise.reject(new Error('tx-service down'))
            : exportOf(1, (n) => exportRow(safeAddress, n))(rest),
      );
      const res = await csv().expect(200);
      const rows = lines(res.body as string);
      expect(rows).toHaveLength(3);
      expect(rows[1]).toBe(`${CHAIN},Ops,,${SAFE_A},,,,,,,,,,,,,unavailable`);
      expect(rows[2]).toContain(',executed');
    });

    it('guards every cell against spreadsheet formulas', async () => {
      await link(orgA, SAFE_A, CHAIN, '=HYPERLINK("x")');
      exportApi.export.mockImplementation(
        exportOf(1, (n) =>
          exportRow(SAFE_A, n, { note: '@cmd', assetSymbol: '+SUM(1)' }),
        ),
      );
      const res = await csv().expect(200);
      const row = lines(res.body as string)[1];
      expect(row).toContain(`"'=HYPERLINK(""x"")"`);
      expect(row).toContain(`'@cmd`);
      expect(row).toContain(`'+SUM(1)`);
    });

    it('stops at the row cap with a truncated row', async () => {
      await link(orgA, SAFE_A, CHAIN, 'Ops');
      exportApi.export.mockImplementation(
        exportOf(1000, (n) => exportRow(SAFE_A, n)),
      );
      const res = await csv().expect(200);
      const rows = lines(res.body as string);
      expect(rows).toHaveLength(1 + 250 + 1);
      expect(rows[rows.length - 1].endsWith(',truncated')).toBe(true);
    });

    it('stops a Safe on an empty page even when the server says there is more', async () => {
      await link(orgA, SAFE_A, CHAIN, 'Ops');
      exportApi.export.mockResolvedValue({
        count: 10,
        next: 'next',
        previous: null,
        results: [],
      });
      const rows = lines((await csv().expect(200)).body as string);
      expect(rows).toHaveLength(1);
      expect(exportApi.export).toHaveBeenCalledTimes(1);
    });

    it('stops at the page cap with a truncated row, independent of the row cap', async () => {
      await link(orgA, SAFE_A, CHAIN, 'Ops');
      // one row per page, always "more": only the request cap ends it
      exportApi.export.mockImplementation(({ offset }: { offset: number }) =>
        Promise.resolve({
          count: null,
          next: 'next',
          previous: null,
          results: [exportRow(SAFE_A, offset)],
        }),
      );
      const rows = lines((await csv().expect(200)).body as string);
      expect(exportApi.export).toHaveBeenCalledTimes(5);
      expect(rows).toHaveLength(1 + 5 + 1);
      expect(rows[rows.length - 1].endsWith(',truncated')).toBe(true);
    });

    it('does not mark an export that ends exactly at the cap as truncated', async () => {
      await link(orgA, SAFE_A, CHAIN, 'Ops');
      exportApi.export.mockImplementation(
        exportOf(250, (n) => exportRow(SAFE_A, n)),
      );
      const rows = lines((await csv().expect(200)).body as string);
      expect(rows).toHaveLength(1 + 250);
      expect(rows.some((r) => r.endsWith(',truncated'))).toBe(false);
    });

    it.each([
      ['missing range', ''],
      ['missing end', '?executedFrom=2026-01-01'],
      ['not a date', '?executedFrom=yesterday&executedTo=2026-01-01'],
      ['end before start', '?executedFrom=2026-02-01&executedTo=2026-01-01'],
      ['366 days', '?executedFrom=2025-01-01&executedTo=2026-01-02'],
      [
        'long datetime range',
        '?executedFrom=2024-01-01T00:00:00Z&executedTo=2026-01-01T00:00:00Z',
      ],
    ])('rejects %s with 400', async (_name, query) => {
      await link(orgA, SAFE_A);
      await csv(query).expect(400);
      expect(exportApi.export).not.toHaveBeenCalled();
    });

    it('does not spend the export budget on invalid ranges', async () => {
      const u = await signIn();
      const org = await createOrg([u]);
      for (let i = 0; i < 20; i++) await csv('', org, u).expect(400);
      await csv(q, org, u).expect(200);
    });

    it('marks a Safe that fails after some pages as partial', async () => {
      await link(orgA, SAFE_A, CHAIN, 'Ops');
      exportApi.export.mockImplementation(
        ({ offset, ...rest }: { limit: number; offset: number }) =>
          offset === 0
            ? exportOf(150, (n) => exportRow(SAFE_A, n))({ offset, ...rest })
            : Promise.reject(new Error('page 2 failed')),
      );
      const rows = lines((await csv().expect(200)).body as string);
      expect(rows).toHaveLength(1 + 100 + 1);
      expect(rows[101]).toBe(`${CHAIN},Ops,,${SAFE_A},,,,,,,,,,,,,partial`);
      expect(rows.some((r) => r.endsWith(',unavailable'))).toBe(false);
    });

    it('accepts 365 days', async () => {
      await csv('?executedFrom=2025-01-01&executedTo=2026-01-01').expect(200);
    });

    it('answers 429 when the user export budget is spent', async () => {
      const u = await signIn();
      const org = await createOrg([u]);
      for (let i = 0; i < 20; i++) await csv(q, org, u).expect(200);
      const res = await csv(q, org, u).expect(429);
      expect(res.status).toBe(429);
    });

    it('answers 404 for the export of another org', async () => {
      await csv(q, orgA, adminB).expect(404);
      await csv(q, orgB, admin).expect(404);
    });
  });
});
