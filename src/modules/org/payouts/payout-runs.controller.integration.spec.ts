import { randomUUID } from 'node:crypto';
import { Global, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { getDataSourceToken, TypeOrmModule } from '@nestjs/typeorm';
import request from 'supertest';
import type { DataSource, EntityManager } from 'typeorm';
import type { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';
import {
  decodeFunctionData,
  encodeErrorResult,
  erc20Abi,
  getAddress,
  parseAbi,
  size,
  type Address,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { IConfigurationService } from '@/config/configuration.service.interface';
import {
  CacheModule,
  type RedisClientType,
} from '@/datasources/cache/cache.module';
import { DataSourceError } from '@/domain/errors/data-source.error';
import { IBlockchainApiManager } from '@/domain/interfaces/blockchain-api.manager.interface';
import { ITransactionApiManager } from '@/domain/interfaces/transaction-api.manager.interface';
import { LoggingService } from '@/logging/logging.interface';
import { IBalancesRepository } from '@/modules/balances/domain/balances.repository.interface';
import { IChainsRepository } from '@/modules/chains/domain/chains.repository.interface';
import { ActivityLog } from '@/modules/org/activity/activity-log.service';
import { listenForTests } from '@/modules/org/auth/__tests__/auth-test-app';
import { OrgKeyPrefix } from '@/modules/org/auth/nonce.store';
import { OrgAuthModule } from '@/modules/org/auth/org-auth.module';
import { FieldEncryptionService } from '@/modules/org/crypto/field-encryption.service';
import {
  createOrgTestDb,
  type OrgTestDb,
} from '@/modules/org/db/__tests__/org-test-db';
import { ORG_DATA_SOURCE } from '@/modules/org/db/org-data-source';
import { OrgTransaction } from '@/modules/org/db/org-transaction';
import { CsvService } from '@/modules/csv-export/csv-utils/csv.service';
import { multiSendCall } from '@/modules/org/common/__tests__/multisend.builder';
import {
  simulationReverted,
  toCalls as toSafeCalls,
} from '@/modules/org/payouts/__tests__/payout-test-app';
import {
  estimateRunGas,
  TX_OVERHEAD_GAS,
} from '@/modules/org/payouts/payout-calls';
import { PayoutProposalsService } from '@/modules/org/payouts/payout-proposals.service';
import { PayoutRunsController } from '@/modules/org/payouts/payout-runs.controller';
import { PayoutRunsService } from '@/modules/org/payouts/payout-runs.service';
import { PayoutStatusUpdater } from '@/modules/org/payouts/payout-status.updater';
import { ISafeRepository } from '@/modules/safe/domain/safe.repository.interface';
import type {
  PayoutRunDetail,
  PayoutRunPage,
} from '@/modules/org/payouts/payout.schemas';
import { PermissionsModule } from '@/modules/org/permissions/permissions.module';
import { PolicyContextService } from '@/modules/org/policies/policy-context.service';
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

const addr = (n: number): Address =>
  getAddress(`0x${n.toString(16).padStart(40, '0')}`);
const SAFE_A = addr(0xa1);
const SAFE_B = addr(0xb2);
const USDC = getAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
const NFT = addr(0x4f7);
const NO_DECIMALS = addr(0xdec);
const ALICE = addr(0xa11ce);
const BOB = addr(0xb0b);
const CALL_ONLY = addr(0x3518);

// Gateway repositories are mocked: no network
const chainsRepo = { getChain: jest.fn() };
const txService = { getToken: jest.fn() };
const txApiManager = { getApi: jest.fn() };
const balancesRepo = { getBalances: jest.fn() };
const rpc = { request: jest.fn() };
const blockchainApis = { getApi: jest.fn() };

type User = { cookie: string; userId: string };
type Row = { address: string; amount: string; token: string; name?: string };

describe('payout runs API', () => {
  let db: OrgTestDb;
  let app: NestExpressApplication;
  let sql: DataSource;
  let ipSeq = 0;
  let orgA: string;
  let orgB: string;
  let admin: User;
  let member: User;
  let adminB: User;
  let safeA: string;
  let safeB: string;

  const nextIp = (): string =>
    `10.7.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;
  const http = (): ReturnType<typeof request> => request(app.getHttpServer());

  async function signIn(): Promise<User> {
    const account = privateKeyToAccount(generatePrivateKey());
    const { body: nonce } = await http()
      .get('/v1/orgs/auth/nonce')
      .set('X-Forwarded-For', nextIp())
      .expect(200);
    const message = createSiweMessage({
      address: account.address,
      chainId: 1,
      domain: 'app.example.com',
      nonce: nonce.nonce,
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

  const asOrg = <T>(
    org: string,
    fn: (em: EntityManager) => Promise<T>,
  ): Promise<T> =>
    sql.transaction(async (em) => {
      await em.query(`SELECT set_config('app.org_id', $1, true)`, [org]);
      return fn(em);
    });

  // linked_safes has no RLS (A3): seeded directly
  const linkSafe = async (org: string, address: Address): Promise<string> => {
    const [{ id }] = await sql.query(
      `INSERT INTO linked_safes (org_id, chain_id, address) VALUES ($1, '1', $2) RETURNING id`,
      [org, address],
    );
    return id;
  };

  const addContact = (org: string, address: Address): Promise<unknown> =>
    asOrg(org, (em) =>
      em.query(
        `INSERT INTO contacts (org_id, name, address, chain_ids) VALUES ($1, 'c', $2, '{1}')`,
        [org, address],
      ),
    );

  const setRun = (org: string, runId: string, set: string): Promise<unknown> =>
    asOrg(org, (em) =>
      em.query(`UPDATE payout_runs SET ${set} WHERE id = $1`, [runId]),
    );

  const events = (
    type: string,
  ): Promise<Array<{ payload: Record<string, unknown>; target_id: string }>> =>
    sql.query(
      `SELECT * FROM activity_events WHERE type = $1 ORDER BY created_at`,
      [type],
    );
  const runCount = async (org: string): Promise<number> =>
    asOrg(org, async (em) => {
      const [{ n }] = await em.query(
        `SELECT (SELECT count(*) FROM payout_runs)::int + (SELECT count(*) FROM payout_items)::int AS n`,
      );
      return n;
    });

  const write = (
    method: 'post' | 'patch' | 'delete',
    path: string,
    who: User,
    payload?: object,
  ): request.Test =>
    http()
      [method](`/v1/orgs/${path}`)
      .set('Cookie', who.cookie)
      .set('X-Org-Request', '1')
      .timeout(15_000)
      .send(payload);
  const get = (path: string, who: User): request.Test =>
    http().get(`/v1/orgs/${path}`).set('Cookie', who.cookie).timeout(15_000);
  const upload = (who: User, csv: string, linkedSafeId = safeA): request.Test =>
    http()
      .post(`/v1/orgs/${orgA}/payout-runs/import`)
      .set('Cookie', who.cookie)
      .set('X-Org-Request', '1')
      .field('linkedSafeId', linkedSafeId)
      .field('name', 'March')
      .attach('file', Buffer.from(csv), 'payout.csv');

  const rows: Array<Row> = [
    { address: ALICE, amount: '1.5', token: 'native', name: 'Alice' },
    { address: BOB, amount: '1000.5', token: USDC },
  ];
  const createRun = async (
    r: Array<Row> = rows,
    who: User = member,
  ): Promise<PayoutRunDetail> =>
    (
      await write('post', `${orgA}/payout-runs`, who, {
        linkedSafeId: safeA,
        name: 'March',
        rows: r,
      }).expect(201)
    ).body;

  const addPolicy = (org: string, rules: Array<object>): Promise<unknown> =>
    asOrg(org, async (em) => {
      const [{ id }] = await em.query(
        `INSERT INTO policies (org_id, name) VALUES ($1, 'p') RETURNING id`,
        [org],
      );
      await em.query(
        `INSERT INTO policy_versions (org_id, policy_id, version, scope, rules, config_hash)
         VALUES ($1, $2, 1, '{"safes":[],"chainIds":[]}', $3::jsonb, 'h')`,
        [org, id, JSON.stringify(rules)],
      );
    });

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
      controllers: [PayoutRunsController],
      providers: [
        OrgTransaction,
        ActivityLog,
        FieldEncryptionService,
        PayoutRunsService,
        // the B8 routes share the controller; this spec does not reach them
        PayoutProposalsService,
        PayoutStatusUpdater,
        CsvService,
        { provide: ISafeRepository, useValue: {} },
        PolicyContextService,
        { provide: IChainsRepository, useValue: chainsRepo },
        { provide: ITransactionApiManager, useValue: txApiManager },
        { provide: IBalancesRepository, useValue: balancesRepo },
        { provide: IBlockchainApiManager, useValue: blockchainApis },
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
    app.get(PayoutStatusUpdater).onModuleDestroy();
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
    for (const org of [orgA, orgB]) {
      await asOrg(org, async (em) => {
        await em.query(`DELETE FROM payout_runs`);
        await em.query(`DELETE FROM policies`);
        await em.query(`DELETE FROM contacts`);
      });
    }
    await sql.query(`DELETE FROM linked_safes`);
    await sql.query(`DELETE FROM activity_events`);
    safeA = await linkSafe(orgA, SAFE_A);
    safeB = await linkSafe(orgB, SAFE_B);
    chainsRepo.getChain.mockResolvedValue({
      chainId: '1',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      contractAddresses: {
        multiSendAddress: null,
        multiSendCallOnlyAddress: CALL_ONLY,
      },
    });
    txApiManager.getApi.mockResolvedValue(txService);
    blockchainApis.getApi.mockResolvedValue(rpc);
    rpc.request.mockRejectedValue(new Error('rpc down'));
    txService.getToken.mockImplementation((address: Address) => {
      const a = address.toLowerCase();
      if (a === USDC.toLowerCase())
        return Promise.resolve({
          type: 'ERC20',
          address: USDC,
          decimals: 6,
          symbol: 'USDC',
          name: 'USD Coin',
        });
      if (a === NFT.toLowerCase())
        return Promise.resolve({ type: 'ERC721', address: NFT, symbol: 'N' });
      if (a === NO_DECIMALS.toLowerCase())
        return Promise.resolve({ type: 'ERC20', address: a, symbol: 'X' });
      return Promise.reject(new DataSourceError('Not found', 404));
    });
    // plenty of everything
    balancesRepo.getBalances.mockResolvedValue([
      { tokenAddress: null, token: null, balance: (10n ** 30n).toString() },
      {
        tokenAddress: USDC,
        token: { address: USDC, decimals: 6, symbol: 'USDC' },
        balance: (10n ** 30n).toString(),
      },
    ]);
  });

  it('creates a draft of native and USDC rows as a member', async () => {
    const body = await createRun();
    expect(body.run).toEqual({
      id: expect.any(String),
      name: 'March',
      status: 'draft',
      chainId: '1',
      safeAddress: SAFE_A,
      linkedSafeId: safeA,
      version: 1,
      calls: null,
      estimatedGas: null,
      gasBound: 6_000_000,
      evaluation: null,
      simulation: null,
      safeTxHash: null,
      nonce: null,
      executedTxHash: null,
      review: null,
      pinnedNonce: null,
      verifyingSince: null,
      resolvedBy: null,
      resolvedAt: null,
      resolutionNote: null,
      latestAttempt: null,
      actions: {
        edit: true,
        build: true,
        propose: false,
        release: false,
        cancelReservation: false,
        delete: true,
        resolve: false,
      },
    });
    expect(body.items).toEqual([
      {
        id: expect.any(String),
        line: 1,
        recipient: ALICE,
        name: 'Alice',
        token: 'native',
        symbol: 'ETH',
        decimals: 18,
        amount: '1.5',
        warnings: ['unknown_recipient'],
      },
      {
        id: expect.any(String),
        line: 2,
        recipient: BOB,
        name: null,
        token: USDC,
        symbol: 'USDC',
        decimals: 6,
        amount: '1000.5',
        warnings: ['unknown_recipient'],
      },
    ]);
    expect(body.runWarnings).toEqual([]);
    const [raw] = await asOrg(orgA, (em) =>
      em.query(
        `SELECT amount_raw::text AS raw FROM payout_items WHERE token <> 'native'`,
      ),
    );
    expect(raw.raw).toBe('1000500000');
    const detail = await get(
      `${orgA}/payout-runs/${body.run.id}`,
      member,
    ).expect(200);
    expect(detail.body).toEqual(body);
  });

  it('creates a draft from an uploaded CSV with file line numbers', async () => {
    const res = await upload(
      member,
      `address,amount,token,name\n${ALICE},2,native,A\n${BOB},3,${USDC},B\n`,
    ).expect(201);
    expect(
      (res.body as PayoutRunDetail).items.map((i: { line: number }) => i.line),
    ).toEqual([2, 3]);
  });

  it('rejects the whole CSV when one row has more decimals than its token', async () => {
    const res = await upload(
      member,
      `address,amount,token\n${ALICE},1.000000000000000001,native\n${BOB},1.0000001,${USDC}\n`,
    ).expect(422);
    expect(res.body).toMatchObject({
      code: 'invalid_rows',
      errors: [{ line: 3, reason: 'too_many_decimals' }],
    });
    expect(await runCount(orgA)).toBe(0);
  });

  it('validates JSON rows like CSV rows and reports token problems per line', async () => {
    const res = await write('post', `${orgA}/payout-runs`, member, {
      linkedSafeId: safeA,
      name: 'March',
      rows: [
        { address: ALICE, amount: '1', token: 'USDC' },
        { address: 'nope', amount: '1', token: 'native' },
        { address: BOB, amount: '1', token: NFT },
        { address: BOB, amount: '1', token: NO_DECIMALS },
        { address: BOB, amount: '1', token: addr(0x404) },
        { address: BOB, amount: '1e3', token: 'native' },
        { address: BOB, amount: '0', token: 'native' },
        { address: BOB, amount: '1', token: 'native', name: 'a\u0000b' },
      ],
    }).expect(422);
    expect(res.body.errors).toEqual([
      { line: 1, reason: 'invalid_token' },
      { line: 2, reason: 'invalid_address' },
      { line: 3, reason: 'not_erc20' },
      { line: 4, reason: 'token_decimals_unknown' },
      { line: 5, reason: 'unknown_token' },
      { line: 6, reason: 'invalid_amount' },
      { line: 7, reason: 'zero_amount' },
      { line: 8, reason: 'invalid_name' },
    ]);
    expect(await runCount(orgA)).toBe(0);
  });

  it('flags both lines of a duplicate recipient and token', async () => {
    await addContact(orgA, ALICE);
    const { items } = await createRun([
      { address: ALICE, amount: '1', token: USDC },
      { address: ALICE, amount: '1', token: 'native' },
      { address: ALICE.toLowerCase(), amount: '1', token: USDC.toLowerCase() },
    ]);
    expect(items.map((i) => i.warnings)).toEqual([
      ['duplicate'],
      [],
      ['duplicate'],
    ]);
  });

  it('flags unknown recipients and the Safe itself', async () => {
    await addContact(orgA, ALICE);
    const { items } = await createRun([
      { address: ALICE, amount: '1', token: 'native' },
      { address: BOB, amount: '1', token: 'native' },
      { address: SAFE_A, amount: '1', token: 'native' },
      { address: USDC, amount: '1', token: USDC },
    ]);
    expect(items.map((i) => i.warnings)).toEqual([
      [],
      ['unknown_recipient'],
      ['unknown_recipient', 'self'],
      ['unknown_recipient', 'token_contract'],
    ]);
  });

  it('warns insufficient_balance from the summed raw amounts', async () => {
    balancesRepo.getBalances.mockResolvedValue([
      { tokenAddress: null, token: null, balance: '2000000000000000000' },
      {
        tokenAddress: USDC,
        token: { address: USDC, decimals: 6, symbol: 'USDC' },
        balance: '1000000',
      },
    ]);
    const { runWarnings } = await createRun([
      { address: ALICE, amount: '0.6', token: USDC },
      { address: BOB, amount: '0.400001', token: USDC },
      { address: ALICE, amount: '1', token: 'native' },
      { address: BOB, amount: '1', token: 'native' },
    ]);
    expect(runWarnings).toEqual([
      {
        code: 'insufficient_balance',
        token: USDC,
        symbol: 'USDC',
        required: '1.000001',
        available: '1',
      },
    ]);
  });

  it('warns balance_unknown when the balances cannot be read', async () => {
    balancesRepo.getBalances.mockRejectedValue(new Error('down'));
    const { runWarnings } = await createRun();
    expect(runWarnings).toEqual([
      {
        code: 'balance_unknown',
        token: 'native',
        symbol: 'ETH',
        required: '1.5',
      },
      {
        code: 'balance_unknown',
        token: USDC,
        symbol: 'USDC',
        required: '1000.5',
      },
    ]);
  });

  it('builds one transaction of native and ERC20 calls and maps a policy violation to its item line', async () => {
    await addPolicy(orgA, [
      {
        kind: 'amount_cap',
        capMode: 'per_transfer',
        caps: [
          {
            chainId: '1',
            token: USDC.toLowerCase(),
            maxRaw: '1000000000',
            decimals: 6,
            symbol: 'USDC',
          },
        ],
      },
    ]);
    const { run } = await createRun([
      { address: ALICE, amount: '1.5', token: 'native' },
      { address: BOB, amount: '1000.5', token: USDC },
      { address: ALICE, amount: '5', token: USDC },
    ]);
    const res = await write(
      'post',
      `${orgA}/payout-runs/${run.id}/build`,
      member,
      { expectedVersion: 1 },
    ).expect(200);
    const built = res.body.run;
    expect(built.calls).toEqual([
      { to: ALICE, value: '1500000000000000000', data: '0x' },
      { to: USDC, value: '0', data: expect.stringMatching(/^0xa9059cbb/) },
      { to: USDC, value: '0', data: expect.stringMatching(/^0xa9059cbb/) },
    ]);
    expect(
      decodeFunctionData({ abi: erc20Abi, data: built.calls[1].data as Hex })
        .args,
    ).toEqual([BOB, 1000500000n]);
    expect(built.estimatedGas).toBeGreaterThan(0);
    expect(built.evaluation).toEqual({
      status: 'violation',
      violations: [
        expect.objectContaining({ rule: 'amount_cap', callPath: '1' }),
      ],
    });
    expect(
      (res.body as PayoutRunDetail).items.map(
        (i: { warnings: Array<string> }) => i.warnings,
      ),
    ).toEqual([
      ['unknown_recipient'],
      ['unknown_recipient', 'policy'],
      ['unknown_recipient'],
    ]);
  });

  it('builds a one-item run as a direct call and maps its violation', async () => {
    await addPolicy(orgA, [{ kind: 'recipients_allowlist', tag: 'allowed' }]);
    const { run } = await createRun([rows[0]]);
    const res = await write(
      'post',
      `${orgA}/payout-runs/${run.id}/build`,
      member,
      { expectedVersion: 1 },
    ).expect(200);
    expect(res.body.run.evaluation.violations[0].callPath).toBe('');
    expect(res.body.items[0].warnings).toContain('policy');
  });

  describe('simulation', () => {
    const build = (runId: string, version = 1): request.Test =>
      write('post', `${orgA}/payout-runs/${runId}/build`, member, {
        expectedVersion: version,
      });
    const errorString = (reason: string): Hex =>
      encodeErrorResult({
        abi: parseAbi(['error Error(string)']),
        errorName: 'Error',
        args: [reason],
      });

    it('simulates the MultiSendCallOnly delegatecall through the Safe and takes the gas from it', async () => {
      rpc.request.mockRejectedValue(simulationReverted(100_000n));
      const { run } = await createRun();
      const res = await build(run.id).expect(200);
      const [[{ params }]] = rpc.request.mock.calls;
      expect(params[0].to).toBe(SAFE_A);
      expect(params[1]).toBe('latest');
      expect(res.body.run.simulation).toEqual({
        ok: true,
        gasUsed: '100000',
        at: expect.any(String),
      });
      const calls = toSafeCalls((res.body as PayoutRunDetail).run.calls!);
      const outer = multiSendCall(CALL_ONLY, calls);
      // estimate × 1.1 + 10k + overhead + 16 gas per outer calldata byte
      expect(res.body.run.estimatedGas).toBe(
        Number(
          110_000n + 10_000n + TX_OVERHEAD_GAS + 16n * BigInt(size(outer.data)),
        ),
      );
      expect(res.body.runWarnings).toEqual([]);
    });

    it('warns simulation_failed with the revert reason and keeps the fixed gas estimate', async () => {
      rpc.request.mockRejectedValue(
        simulationReverted(50_000n, false, errorString('GS013')),
      );
      const { run } = await createRun();
      const res = await build(run.id).expect(200);
      expect(res.body.run.simulation).toEqual({
        ok: false,
        reason: 'GS013',
        at: expect.any(String),
      });
      expect(res.body.runWarnings).toEqual([
        { code: 'simulation_failed', message: 'GS013' },
      ]);
      expect(res.body.run.estimatedGas).toBe(
        Number(
          estimateRunGas(toSafeCalls((res.body as PayoutRunDetail).run.calls!)),
        ),
      );
    });

    it('stores a revert reason without control characters, bounded to 200', async () => {
      rpc.request.mockRejectedValue(
        simulationReverted(
          50_000n,
          false,
          errorString(`a\u0000b${'x'.repeat(300)}`),
        ),
      );
      const { run } = await createRun();
      const res = await build(run.id).expect(200);
      expect(res.body.run.simulation.reason).toBe(`ab${'x'.repeat(198)}`);
    });

    it('simulates without transport retries', async () => {
      rpc.request.mockRejectedValue(simulationReverted(100_000n));
      const { run } = await createRun();
      await build(run.id).expect(200);
      expect(rpc.request).toHaveBeenCalledWith(
        { method: 'eth_call', params: expect.any(Array) },
        { retryCount: 0 },
      );
    });

    it('warns simulation_failed with a generic message when the revert has no reason', async () => {
      rpc.request.mockRejectedValue(simulationReverted(50_000n, false));
      const { run } = await createRun();
      const res = await build(run.id).expect(200);
      expect(res.body.runWarnings).toEqual([
        {
          code: 'simulation_failed',
          message: 'The transaction would fail on-chain',
        },
      ]);
    });

    it('warns simulation_unavailable when the RPC fails, and stores no result', async () => {
      const { run } = await createRun();
      const res = await build(run.id).expect(200);
      expect(res.body.run.simulation).toBeNull();
      expect(res.body.runWarnings).toEqual([
        { code: 'simulation_unavailable' },
      ]);
      // an edit drops the transaction and its simulation
      const edited = await write(
        'patch',
        `${orgA}/payout-runs/${run.id}`,
        member,
        { expectedVersion: 2, name: 'April' },
      ).expect(200);
      expect(edited.body.runWarnings).toEqual([]);
    });

    it('answers 422 run_too_large when the simulated gas exceeds the bound', async () => {
      rpc.request.mockRejectedValue(simulationReverted(6_000_000n));
      const { run } = await createRun();
      const res = await build(run.id).expect(422);
      expect(res.body).toMatchObject({
        code: 'run_too_large',
        maxRecipients: 1,
        gasBound: 6_000_000,
      });
    });
  });

  it('answers 422 run_too_large with maxRecipients and estimatedGas and stores nothing when the run exceeds the gas bound', async () => {
    const { run } = await createRun([rows[1]]);
    // more items than create would accept, only reachable by a direct insert
    await asOrg(orgA, (em) =>
      em.query(
        `INSERT INTO payout_items (org_id, run_id, line_no, recipient, token, amount, amount_raw, decimals, symbol)
         SELECT $1, $2, g + 1, lower($3), lower($4), '1', 1000000, 6, 'USDC' FROM generate_series(1, 99) g`,
        [orgA, run.id, ALICE, USDC],
      ),
    );
    const res = await write(
      'post',
      `${orgA}/payout-runs/${run.id}/build`,
      member,
      { expectedVersion: 1 },
    ).expect(422);
    expect(res.body).toEqual({
      statusCode: 422,
      code: 'run_too_large',
      message: expect.stringContaining('at most 81 recipients'),
      maxRecipients: 81,
      estimatedGas: expect.any(Number),
      gasBound: 6_000_000,
    });
    const after = await get(`${orgA}/payout-runs/${run.id}`, member).expect(
      200,
    );
    expect(after.body.run).toMatchObject({ version: 1, calls: null });
  });

  it('answers 422 run_too_large at create and stores nothing', async () => {
    const many = Array.from({ length: 100 }, (_, i) => ({
      address: addr(0x1000 + i),
      amount: '1',
      token: USDC,
    }));
    const res = await write('post', `${orgA}/payout-runs`, member, {
      linkedSafeId: safeA,
      name: 'Big',
      rows: many,
    }).expect(422);
    expect(res.body).toMatchObject({
      code: 'run_too_large',
      maxRecipients: 81,
    });
    expect(await runCount(orgA)).toBe(0);
    expect(await events('payout_run.created')).toEqual([]);
  });

  it('rejects 501 rows', async () => {
    const many = Array.from({ length: 501 }, () => rows[0]);
    const json = await write('post', `${orgA}/payout-runs`, member, {
      linkedSafeId: safeA,
      name: 'Big',
      rows: many,
    }).expect(422);
    expect(json.body.errors).toEqual([{ line: 501, reason: 'too_many_rows' }]);
    const csv = await upload(
      member,
      `address,amount,token\n${`${ALICE},1,native\n`.repeat(501)}`,
    ).expect(422);
    expect(csv.body.errors).toEqual([{ line: 502, reason: 'too_many_rows' }]);
    expect(await runCount(orgA)).toBe(0);
  });

  it('answers 409 version_conflict to a PATCH with a stale expectedVersion', async () => {
    const { run } = await createRun();
    await write('patch', `${orgA}/payout-runs/${run.id}`, member, {
      expectedVersion: 1,
      name: 'April',
    }).expect(200);
    const res = await write('patch', `${orgA}/payout-runs/${run.id}`, member, {
      expectedVersion: 1,
      name: 'May',
    }).expect(409);
    expect(res.body.code).toBe('version_conflict');
  });

  it('replaces the rows on PATCH, resets a built run to draft and records payout_run.updated', async () => {
    const { run } = await createRun();
    await write('post', `${orgA}/payout-runs/${run.id}/build`, member, {
      expectedVersion: 1,
    }).expect(200);
    const res = await write('patch', `${orgA}/payout-runs/${run.id}`, member, {
      expectedVersion: 2,
      rows: [{ address: BOB, amount: '7', token: 'native' }],
    }).expect(200);
    expect(res.body.run).toMatchObject({
      status: 'draft',
      version: 3,
      calls: null,
      estimatedGas: null,
      evaluation: null,
    });
    expect(res.body.items).toEqual([
      expect.objectContaining({ line: 1, recipient: BOB, amount: '7' }),
    ]);
    const [, ev] = await events('payout_run.updated');
    expect(ev.payload).toEqual({
      name: 'March',
      chainId: '1',
      address: SAFE_A,
      items: 1,
      itemsHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      fromStatus: 'draft',
    });
  });

  it('bumps version on build', async () => {
    const { run } = await createRun();
    const first = await write(
      'post',
      `${orgA}/payout-runs/${run.id}/build`,
      member,
      { expectedVersion: 1 },
    ).expect(200);
    expect(first.body.run.version).toBe(2);
    const second = await write(
      'post',
      `${orgA}/payout-runs/${run.id}/build`,
      member,
      { expectedVersion: 2 },
    ).expect(200);
    expect(second.body.run.version).toBe(3);
    expect(second.body.run.calls).toEqual(first.body.run.calls);
  });

  it('answers 409 run_locked to PATCH, DELETE and build of a proposing, proposed or verifying run', async () => {
    const { run } = await createRun();
    for (const status of ['proposing', 'proposed', 'verifying']) {
      await setRun(orgA, run.id, `status = '${status}', pinned_nonce = 4`);
      const patch = await write(
        'patch',
        `${orgA}/payout-runs/${run.id}`,
        member,
        {
          expectedVersion: 1,
          name: 'x',
        },
      ).expect(409);
      expect(patch.body).toMatchObject({ code: 'run_locked', status });
      const del = await write(
        'delete',
        `${orgA}/payout-runs/${run.id}`,
        member,
      ).expect(409);
      expect(del.body).toMatchObject({ code: 'run_locked', status });
      const build = await write(
        'post',
        `${orgA}/payout-runs/${run.id}/build`,
        member,
        { expectedVersion: 1 },
      ).expect(409);
      expect(build.body).toMatchObject({ code: 'run_locked', status });
    }
  });

  it('rejects editing rows and building once the run is proposed with 409 run_locked', async () => {
    const { run } = await createRun();
    await setRun(orgA, run.id, `status = 'proposed', pinned_nonce = 4`);
    const res = await write('patch', `${orgA}/payout-runs/${run.id}`, member, {
      expectedVersion: 1,
      rows: [{ address: BOB, amount: '7', token: 'native' }],
    }).expect(409);
    expect(res.body.code).toBe('run_locked');
    await write('post', `${orgA}/payout-runs/${run.id}/build`, member, {
      expectedVersion: 1,
    }).expect(409);
    const items = await get(`${orgA}/payout-runs/${run.id}`, member).expect(
      200,
    );
    expect(items.body.items).toHaveLength(2);
  });

  it('allows PATCH and build of a pinned draft and keeps the pin', async () => {
    const { run } = await createRun();
    await setRun(orgA, run.id, `pinned_nonce = 7`);
    await write('patch', `${orgA}/payout-runs/${run.id}`, member, {
      expectedVersion: 1,
      rows: [{ address: BOB, amount: '7', token: 'native' }],
    }).expect(200);
    const res = await write(
      'post',
      `${orgA}/payout-runs/${run.id}/build`,
      member,
      { expectedVersion: 2 },
    ).expect(200);
    expect(res.body.run).toMatchObject({
      status: 'draft',
      pinnedNonce: '7',
      version: 3,
    });
  });

  it('delete of a pinned draft → 409 run_pinned', async () => {
    const { run } = await createRun();
    await setRun(orgA, run.id, `pinned_nonce = 7`);
    const res = await write(
      'delete',
      `${orgA}/payout-runs/${run.id}`,
      member,
    ).expect(409);
    expect(res.body.code).toBe('run_pinned');
    await setRun(orgA, run.id, `pinned_nonce = NULL, status = 'failed'`);
    await write('delete', `${orgA}/payout-runs/${run.id}`, member).expect(204);
    const [ev] = await events('payout_run.deleted');
    expect(ev).toMatchObject({ target_id: run.id, payload: { items: 2 } });
    await get(`${orgA}/payout-runs/${run.id}`, member).expect(404);
  });

  it('returns the pin, verifying fields, review and latestAttempt releasable for the claimer and payouts.manage only', async () => {
    const { run } = await createRun();
    await setRun(
      orgA,
      run.id,
      `status = 'proposing', pinned_nonce = 9, review = NULL`,
    );
    await asOrg(orgA, (em) =>
      em.query(
        `INSERT INTO payout_proposal_attempts (org_id, run_id, run_version, nonce, calls, created_by)
         VALUES ($1, $2, 1, 9, '[]', $3)`,
        [orgA, run.id, member.userId],
      ),
    );
    const asMember = await get(`${orgA}/payout-runs/${run.id}`, member).expect(
      200,
    );
    expect(asMember.body.run).toMatchObject({
      status: 'proposing',
      pinnedNonce: '9',
      latestAttempt: {
        id: expect.any(String),
        status: 'open',
        nonce: '9',
        createdBy: member.userId,
        createdAt: expect.any(String),
        releasable: true,
      },
    });
    const asAdmin = await get(`${orgA}/payout-runs/${run.id}`, admin).expect(
      200,
    );
    expect(asAdmin.body.run.latestAttempt.releasable).toBe(true);
    const other = await signIn();
    const [{ id: memberId }] = await sql.query(
      `INSERT INTO members (org_id, user_id, status) VALUES ($1, $2, 'active') RETURNING id`,
      [orgA, other.userId],
    );
    await sql.query(
      `INSERT INTO role_bindings (member_id, role_id, scope)
         SELECT $1, id, 'org' FROM roles WHERE org_id IS NULL AND key = 'member'`,
      [memberId],
    );
    const asOther = await get(`${orgA}/payout-runs/${run.id}`, other).expect(
      200,
    );
    expect(asOther.body.run.latestAttempt.releasable).toBe(false);

    await setRun(orgA, run.id, `status = 'verifying', verifying_since = now()`);
    const verifying = await get(`${orgA}/payout-runs/${run.id}`, member).expect(
      200,
    );
    expect(verifying.body.run).toMatchObject({
      verifyingSince: expect.any(String),
      latestAttempt: { releasable: false },
    });
    // nothing left to pay from the balance
    expect(verifying.body.runWarnings).toEqual([]);
    expect(balancesRepo.getBalances).toHaveBeenCalledTimes(4);
  });

  it('keeps listing a run after its Safe is unlinked, with linkedSafeId null', async () => {
    const { run } = await createRun();
    const listed = await get(`${orgA}/payout-runs`, member).expect(200);
    expect(listed.body).toEqual({
      items: [
        {
          id: run.id,
          name: 'March',
          status: 'draft',
          chainId: '1',
          safeAddress: SAFE_A,
          linkedSafeId: safeA,
          itemCount: 2,
          safeTxHash: null,
          createdAt: expect.any(String),
        },
      ],
      nextCursor: null,
    });
    const filtered = await get(
      `${orgA}/payout-runs?linkedSafeId=${safeA}`,
      member,
    ).expect(200);
    expect(filtered.body.items).toHaveLength(1);
    await sql.query(`DELETE FROM linked_safes WHERE id = $1`, [safeA]);
    const after = await get(`${orgA}/payout-runs`, member).expect(200);
    expect(after.body.items).toEqual([
      expect.objectContaining({ id: run.id, linkedSafeId: null }),
    ]);
    const detail = await get(`${orgA}/payout-runs/${run.id}`, member).expect(
      200,
    );
    expect(detail.body.run.linkedSafeId).toBeNull();
  });

  it('pages the run list newest first by cursor (limit default 50, max 100)', async () => {
    const { run } = await createRun();
    // 6 more runs with distinct and equal creation times (ties broken by id)
    await asOrg(orgA, (em) =>
      em.query(
        `INSERT INTO payout_runs (org_id, chain_id, safe_address, name, created_at)
         SELECT $1, '1', $2, 'r' || g, now() - interval '1 hour' - (g / 2) * interval '1 minute'
           FROM generate_series(1, 6) g`,
        [orgA, SAFE_A.toLowerCase()],
      ),
    );
    const seen: Array<string> = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res: request.Response = await get(
        `${orgA}/payout-runs?limit=3${cursor ? `&cursor=${cursor}` : ''}`,
        member,
      ).expect(200);
      const page = res.body as PayoutRunPage;
      expect(page.items.length).toBeLessThanOrEqual(3);
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
      pages++;
    } while (cursor !== null);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(7);
    expect(seen[0]).toBe(run.id);

    const all = await get(`${orgA}/payout-runs`, member).expect(200);
    expect((all.body as PayoutRunPage).items.map((i) => i.id)).toEqual(seen);
    expect(all.body.nextCursor).toBeNull();

    await get(`${orgA}/payout-runs?limit=101`, member).expect(400);
    await get(`${orgA}/payout-runs?limit=0`, member).expect(400);
    await get(`${orgA}/payout-runs?cursor=garbage`, member).expect(400);
  });

  it('answers 404 for a run of another org and for a linkedSafeId of another org', async () => {
    const { run } = await createRun();
    await get(`${orgB}/payout-runs/${run.id}`, adminB).expect(404);
    await write('post', `${orgB}/payout-runs/${run.id}/build`, adminB, {
      expectedVersion: 1,
    }).expect(404);
    await write('delete', `${orgB}/payout-runs/${run.id}`, adminB).expect(404);
    await get(`${orgA}/payout-runs?linkedSafeId=${safeB}`, member).expect(404);
    await write('post', `${orgA}/payout-runs`, member, {
      linkedSafeId: safeB,
      name: 'x',
      rows,
    }).expect(404);
    await get(`${orgA}/payout-runs/not-a-uuid`, member).expect(404);
    expect(await runCount(orgB)).toBe(0);
  });

  it('records payout_run.created in the same transaction', async () => {
    const { run } = await createRun();
    const created = await events('payout_run.created');
    expect(created).toEqual([
      expect.objectContaining({
        target_id: run.id,
        payload: {
          name: 'March',
          chainId: '1',
          address: SAFE_A,
          items: 2,
          itemsHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
      }),
    ]);
    // now() is the transaction start: equal timestamps mean one transaction
    const [same] = await asOrg(orgA, (em) =>
      em.query(
        `SELECT r.created_at = e.created_at AS same
           FROM payout_runs r JOIN activity_events e ON e.target_id = r.id::text
          WHERE r.id = $1`,
        [run.id],
      ),
    );
    expect(same.same).toBe(true);
  });

  it('answers 409 version_conflict to a build with a stale expectedVersion and 400 without one', async () => {
    const { run } = await createRun();
    const stale = await write(
      'post',
      `${orgA}/payout-runs/${run.id}/build`,
      member,
      { expectedVersion: 2 },
    ).expect(409);
    expect(stale.body.code).toBe('version_conflict');
    await write('post', `${orgA}/payout-runs/${run.id}/build`, member).expect(
      400,
    );
  });

  it('answers 409 version_conflict to a stale PATCH before reading any token', async () => {
    const { run } = await createRun();
    txService.getToken.mockClear();
    chainsRepo.getChain.mockClear();
    const res = await write('patch', `${orgA}/payout-runs/${run.id}`, member, {
      expectedVersion: 5,
      rows: [{ address: BOB, amount: '7', token: USDC }],
    }).expect(409);
    expect(res.body.code).toBe('version_conflict');
    expect(txService.getToken).not.toHaveBeenCalled();
    expect(chainsRepo.getChain).not.toHaveBeenCalled();
  });

  it('answers 422 invalid_rows to JSON rows with wrong types or oversized cells', async () => {
    const res = await write('post', `${orgA}/payout-runs`, member, {
      linkedSafeId: safeA,
      name: 'March',
      rows: [
        { address: ALICE, amount: 5, token: 'native' },
        { address: ALICE, amount: '1'.repeat(150), token: 'native' },
        { address: ALICE, amount: '1', token: 'native', name: 'x'.repeat(70) },
        'not a row',
        { address: 'x'.repeat(300), amount: '1', token: 'native' },
      ],
    }).expect(422);
    expect(res.body).toMatchObject({
      code: 'invalid_rows',
      errors: [
        { line: 1, reason: 'invalid_row' },
        { line: 2, reason: 'invalid_amount' },
        { line: 3, reason: 'name_too_long' },
        { line: 4, reason: 'invalid_row' },
        { line: 5, reason: 'invalid_address' },
      ],
    });
    const empty = await write('post', `${orgA}/payout-runs`, member, {
      linkedSafeId: safeA,
      name: 'March',
      rows: [],
    }).expect(422);
    expect(empty.body.errors).toEqual([{ line: 1, reason: 'no_rows' }]);
    expect(await runCount(orgA)).toBe(0);
  });

  it('computes unknown_recipient, policy and evaluation from the current contacts and policies on read', async () => {
    const { run } = await createRun();
    expect(run.evaluation).toBeNull();
    await addContact(orgA, ALICE);
    await addPolicy(orgA, [
      {
        kind: 'amount_cap',
        capMode: 'per_transfer',
        caps: [
          {
            chainId: '1',
            token: USDC.toLowerCase(),
            maxRaw: '1000000000',
            decimals: 6,
            symbol: 'USDC',
          },
        ],
      },
    ]);
    // not built: the item warnings already show the policy
    const draft = await get(`${orgA}/payout-runs/${run.id}`, member).expect(
      200,
    );
    expect(
      (draft.body as PayoutRunDetail).items.map((i) => i.warnings),
    ).toEqual([[], ['unknown_recipient', 'policy']]);
    expect(draft.body.run.evaluation).toBeNull();
    await write('post', `${orgA}/payout-runs/${run.id}/build`, member, {
      expectedVersion: 1,
    }).expect(200);
    await asOrg(orgA, (em) => em.query(`DELETE FROM policies`));
    await addContact(orgA, BOB);
    const built = await get(`${orgA}/payout-runs/${run.id}`, member).expect(
      200,
    );
    expect(built.body.run.evaluation).toEqual({ status: 'ok' });
    expect(
      (built.body as PayoutRunDetail).items.map((i) => i.warnings),
    ).toEqual([[], []]);
  });

  it('exposes the attempt of the active proposal, not the newest one, after release A, claim and release B', async () => {
    const { run } = await createRun();
    const attempt = (): Promise<string> =>
      asOrg(orgA, async (em) => {
        const [{ id }] = await em.query(
          `INSERT INTO payout_proposal_attempts (org_id, run_id, run_version, nonce, calls, created_by)
           VALUES ($1, $2, 1, 9, '[]', $3) RETURNING id`,
          [orgA, run.id, member.userId],
        );
        return id;
      });
    const setAttempt = (id: string, set: string): Promise<unknown> =>
      asOrg(orgA, (em) =>
        em.query(`UPDATE payout_proposal_attempts SET ${set} WHERE id = $1`, [
          id,
        ]),
      );
    const a = await attempt();
    await setAttempt(a, `status = 'released', release_reason = 'released'`);
    const b = await attempt();
    await setRun(orgA, run.id, `status = 'proposing', pinned_nonce = 9`);
    const proposing = await get(`${orgA}/payout-runs/${run.id}`, member).expect(
      200,
    );
    expect(proposing.body.run.latestAttempt).toMatchObject({
      id: b,
      status: 'open',
      releasable: true,
    });
    await setAttempt(b, `status = 'released', release_reason = 'released'`);
    await setRun(orgA, run.id, `status = 'draft'`);
    const draft = await get(`${orgA}/payout-runs/${run.id}`, member).expect(
      200,
    );
    expect(draft.body.run.latestAttempt).toMatchObject({
      id: b,
      releasable: false,
    });
  });

  it('records payout_run.updated with fromStatus on build and an itemsHash that changes when recipients are swapped', async () => {
    const two: Array<Row> = [
      { address: ALICE, amount: '1', token: 'native' },
      { address: BOB, amount: '2', token: 'native' },
    ];
    const { run } = await createRun(two);
    await setRun(orgA, run.id, `status = 'failed'`);
    await write('post', `${orgA}/payout-runs/${run.id}/build`, member, {
      expectedVersion: 1,
    }).expect(200);
    await write('patch', `${orgA}/payout-runs/${run.id}`, member, {
      expectedVersion: 2,
      rows: [
        { ...two[0], address: BOB },
        { ...two[1], address: ALICE },
      ],
    }).expect(200);
    const [created] = await events('payout_run.created');
    const [built, patched] = await events('payout_run.updated');
    expect(built.payload).toMatchObject({
      fromStatus: 'failed',
      items: 2,
      itemsHash: created.payload.itemsHash,
    });
    expect(patched.payload.fromStatus).toBe('draft');
    expect(patched.payload.itemsHash).not.toBe(created.payload.itemsHash);
  });

  it('answers 409 safe_unlinked to PATCH and build after the Safe is unlinked', async () => {
    const { run } = await createRun();
    await sql.query(`DELETE FROM linked_safes WHERE id = $1`, [safeA]);
    const patch = await write(
      'patch',
      `${orgA}/payout-runs/${run.id}`,
      member,
      {
        expectedVersion: 1,
        name: 'x',
      },
    ).expect(409);
    expect(patch.body.code).toBe('safe_unlinked');
    const build = await write(
      'post',
      `${orgA}/payout-runs/${run.id}/build`,
      member,
      { expectedVersion: 1 },
    ).expect(409);
    expect(build.body.code).toBe('safe_unlinked');
  });

  it('limits multipart fields and parts on the CSV import', async () => {
    const req = http()
      .post(`/v1/orgs/${orgA}/payout-runs/import`)
      .set('Cookie', member.cookie)
      .set('X-Org-Request', '1')
      .field('linkedSafeId', safeA)
      .field('name', 'March');
    for (let i = 0; i < 4; i++) req.field(`extra${i}`, 'x');
    await req
      .attach(
        'file',
        Buffer.from(`address,amount,token\n${ALICE},1,native`),
        'p.csv',
      )
      .expect(400);
    await http()
      .post(`/v1/orgs/${orgA}/payout-runs/import`)
      .set('Cookie', member.cookie)
      .set('X-Org-Request', '1')
      .field('linkedSafeId', safeA)
      .field('name', 'x'.repeat(2000))
      .attach(
        'file',
        Buffer.from(`address,amount,token\n${ALICE},1,native`),
        'p.csv',
      )
      .expect(400);
    expect(await runCount(orgA)).toBe(0);
  });

  it('keeps the stored evaluation and its policy warnings once the run left draft, even after a policy change', async () => {
    const cap = (maxRaw: string): Array<object> => [
      {
        kind: 'amount_cap',
        capMode: 'per_transfer',
        caps: [
          {
            chainId: '1',
            token: USDC.toLowerCase(),
            maxRaw,
            decimals: 6,
            symbol: 'USDC',
          },
        ],
      },
    ];
    await addPolicy(orgA, cap('1000000000'));
    const { run } = await createRun();
    const built = await write(
      'post',
      `${orgA}/payout-runs/${run.id}/build`,
      member,
      { expectedVersion: 1 },
    ).expect(200);
    const stored = built.body.run.evaluation;
    expect(stored.status).toBe('violation');
    await setRun(
      orgA,
      run.id,
      `status = 'executed', executed_tx_hash = '0x${'cd'.repeat(32)}'`,
    );
    // the policy no longer flags the run; the executed run keeps what it was built with
    await asOrg(orgA, (em) => em.query(`DELETE FROM policies`));
    await addPolicy(orgA, cap('5000000000'));
    const res = await get(`${orgA}/payout-runs/${run.id}`, member).expect(200);
    expect(res.body.run.evaluation).toEqual(stored);
    expect((res.body as PayoutRunDetail).items.map((i) => i.warnings)).toEqual([
      ['unknown_recipient'],
      ['unknown_recipient', 'policy'],
    ]);
    // back in an editable status it follows the current policies again
    await setRun(orgA, run.id, `status = 'failed'`);
    const failed = await get(`${orgA}/payout-runs/${run.id}`, member).expect(
      200,
    );
    expect(failed.body.run.evaluation).toEqual({ status: 'ok' });
    expect(
      (failed.body as PayoutRunDetail).items.map((i) => i.warnings),
    ).toEqual([['unknown_recipient'], ['unknown_recipient']]);
  });
});
