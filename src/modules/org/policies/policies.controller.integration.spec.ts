import { randomUUID } from 'node:crypto';
import { Global, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { getDataSourceToken, TypeOrmModule } from '@nestjs/typeorm';
import request from 'supertest';
import type { DataSource, EntityManager } from 'typeorm';
import type { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';
import { getAddress, type Address } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { IConfigurationService } from '@/config/configuration.service.interface';
import {
  CacheModule,
  type RedisClientType,
} from '@/datasources/cache/cache.module';
import {
  getMultiSendCallOnlyDeployments,
  getMultiSendDeployments,
} from '@/domain/common/utils/deployments';
import { DataSourceError } from '@/domain/errors/data-source.error';
import { LoggingService } from '@/logging/logging.interface';
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
import { PermissionsModule } from '@/modules/org/permissions/permissions.module';
import { FindingsController } from '@/modules/org/policies/findings.controller';
import { PoliciesController } from '@/modules/org/policies/policies.controller';
import { PoliciesService } from '@/modules/org/policies/policies.service';
import { PolicyContextService } from '@/modules/org/policies/policy-context.service';
import type { CompiledPolicy } from '@/modules/org/policies/policy-rules';
import { ITransactionApiManager } from '@/domain/interfaces/transaction-api.manager.interface';
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
const CUSTOM_MULTISEND = addr(0x3517);
const CUSTOM_CALL_ONLY = addr(0x3518);

// Gateway repositories are mocked: no network
const chainsRepo = { getChain: jest.fn() };
// raw tx-service token reads (the policy service checks decimals are present)
const txService = { getToken: jest.fn() };
const txApiManager = { getApi: jest.fn() };

type User = { cookie: string; userId: string };
type PolicyBody = {
  name: string;
  enabled: boolean;
  scope: {
    safes: Array<{ chainId: string; address: string }>;
    chainIds: Array<string>;
  };
  rules: Array<Record<string, unknown>>;
  expectedVersion?: number;
};

const body = (over: Partial<PolicyBody> = {}): PolicyBody => ({
  name: 'Payments',
  enabled: true,
  scope: { safes: [], chainIds: [] },
  rules: [{ kind: 'no_delegatecall' }],
  ...over,
});
const usdcCap = (maxAmount: string): Record<string, unknown> => ({
  kind: 'amount_cap',
  capMode: 'per_transfer',
  caps: [{ chainId: '1', token: USDC, maxAmount }],
});

describe('policies API and evaluation context', () => {
  let db: OrgTestDb;
  let app: NestExpressApplication;
  let sql: DataSource;
  let context: PolicyContextService;
  let tx: OrgTransaction;
  let ipSeq = 0;
  let orgA: string;
  let orgB: string;
  let admin: User;
  let member: User;
  let adminB: User;

  const nextIp = (): string =>
    `10.6.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;
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
  const linkSafe = async (
    org: string,
    address: Address,
    chainId = '1',
  ): Promise<void> => {
    await sql.query(
      `INSERT INTO linked_safes (org_id, chain_id, address) VALUES ($1, $2, $3)`,
      [org, chainId, address],
    );
  };
  const unlinkSafe = async (org: string, address: Address): Promise<void> => {
    await sql.query(
      `DELETE FROM linked_safes WHERE org_id = $1 AND address = $2`,
      [org, address],
    );
  };

  const events = (
    type: string,
  ): Promise<Array<{ payload: Record<string, unknown>; target_id: string }>> =>
    sql.query(
      `SELECT * FROM activity_events WHERE type = $1 ORDER BY created_at`,
      [type],
    );

  const write = (
    method: 'post' | 'put' | 'delete',
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
  const create = async (
    over: Partial<PolicyBody> = {},
  ): Promise<{ id: string; version: number; configHash: string }> =>
    (await write('post', `${orgA}/policies`, admin, body(over)).expect(201))
      .body;

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
      controllers: [PoliciesController, FindingsController],
      providers: [
        OrgTransaction,
        ActivityLog,
        FieldEncryptionService,
        PoliciesService,
        PolicyContextService,
        { provide: IChainsRepository, useValue: chainsRepo },
        { provide: ITransactionApiManager, useValue: txApiManager },
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
    context = moduleRef.get(PolicyContextService);
    tx = moduleRef.get(OrgTransaction);

    admin = await signIn();
    member = await signIn();
    adminB = await signIn();
    orgA = await createOrg([
      [admin, 'admin'],
      [member, 'member'],
    ]);
    orgB = await createOrg([[adminB, 'admin']]);
    await sql.query(
      `UPDATE sessions SET last_strong_auth_at = now() WHERE user_id = ANY($1)`,
      [[admin.userId, adminB.userId]],
    );
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
        await em.query(`DELETE FROM policies`);
        await em.query(`DELETE FROM contacts`);
      });
    }
    await sql.query(`DELETE FROM linked_safes`);
    await sql.query(`DELETE FROM activity_events`);
    chainsRepo.getChain.mockResolvedValue({
      chainId: '1',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      contractAddresses: {
        multiSendAddress: CUSTOM_MULTISEND,
        multiSendCallOnlyAddress: CUSTOM_CALL_ONLY,
      },
    });
    txApiManager.getApi.mockResolvedValue(txService);
    txService.getToken.mockImplementation((address: Address) =>
      address.toLowerCase() === USDC.toLowerCase()
        ? Promise.resolve({
            type: 'ERC20',
            address: USDC,
            decimals: 6,
            symbol: 'USDC',
            name: 'USD Coin',
          })
        : Promise.reject(new DataSourceError('Not found', 404)),
    );
  });

  it('creates a policy as admin with fresh strong auth and records policy.created', async () => {
    const res = await write(
      'post',
      `${orgA}/policies`,
      admin,
      body({ rules: [{ kind: 'no_delegatecall' }, usdcCap('5')] }),
    ).expect(201);
    expect(res.body).toEqual({
      id: expect.any(String),
      name: 'Payments',
      status: 'active',
      version: 1,
      configHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      scope: { safes: [], chainIds: [] },
      rules: [
        { kind: 'no_delegatecall' },
        {
          kind: 'amount_cap',
          capMode: 'per_transfer',
          caps: [
            {
              chainId: '1',
              token: USDC.toLowerCase(),
              maxRaw: '5000000',
              decimals: 6,
              symbol: 'USDC',
              maxAmount: '5',
            },
          ],
        },
      ],
      updatedAt: expect.any(String),
    });
    const [ev] = await events('policy.created');
    expect(ev).toMatchObject({
      target_id: res.body.id,
      payload: { name: 'Payments', version: 1 },
    });
    const listed = await get(`${orgA}/policies`, admin).expect(200);
    expect(listed.body).toEqual([res.body]);
  });

  it('answers 403 step_up_required without fresh strong auth', async () => {
    await sql.query(
      `UPDATE sessions SET last_strong_auth_at = NULL WHERE user_id = $1`,
      [admin.userId],
    );
    try {
      const res = await write('post', `${orgA}/policies`, admin, body()).expect(
        403,
      );
      expect(res.body.code).toBe('step_up_required');
    } finally {
      await sql.query(
        `UPDATE sessions SET last_strong_auth_at = now() WHERE user_id = $1`,
        [admin.userId],
      );
    }
  });

  it('answers 403 to a member writing and 200 to a member reading', async () => {
    await sql.query(
      `UPDATE sessions SET last_strong_auth_at = now() WHERE user_id = $1`,
      [member.userId],
    );
    await write('post', `${orgA}/policies`, member, body()).expect(403);
    const { id } = await create();
    await write('put', `${orgA}/policies/${id}`, member, {
      ...body({ name: 'x' }),
      expectedVersion: 1,
    }).expect(403);
    await write('delete', `${orgA}/policies/${id}`, member).expect(403);
    const res = await get(`${orgA}/policies`, member).expect(200);
    expect(res.body).toHaveLength(1);
  });

  it('stores a USDC cap of 1000.5 as maxRaw 1000500000', async () => {
    const { id } = await create({ rules: [usdcCap('1000.5')] });
    const [row] = await asOrg(orgA, (em) =>
      em.query(`SELECT rules FROM policy_versions WHERE policy_id = $1`, [id]),
    );
    expect(row.rules).toEqual([
      {
        kind: 'amount_cap',
        capMode: 'per_transfer',
        caps: [
          {
            chainId: '1',
            token: USDC.toLowerCase(),
            maxRaw: '1000500000',
            decimals: 6,
            symbol: 'USDC',
          },
        ],
      },
    ]);
    const listed = await get(`${orgA}/policies`, admin).expect(200);
    expect(listed.body[0].rules[0].caps[0].maxAmount).toBe('1000.5');
  });

  it('resolves a native cap from the chain currency', async () => {
    const { id } = await create({
      rules: [
        {
          kind: 'amount_cap',
          capMode: 'both',
          caps: [{ chainId: '1', token: 'native', maxAmount: '2.5' }],
        },
      ],
    });
    const listed = await get(`${orgA}/policies`, admin).expect(200);
    const policy = (
      listed.body as Array<{
        id: string;
        rules: Array<{ caps: Array<unknown> }>;
      }>
    ).find((p) => p.id === id);
    expect(policy?.rules[0].caps[0]).toEqual({
      chainId: '1',
      token: 'native',
      maxRaw: '2500000000000000000',
      decimals: 18,
      symbol: 'ETH',
      maxAmount: '2.5',
    });
  });

  it('rejects a cap with more decimals than the token', async () => {
    const res = await write(
      'post',
      `${orgA}/policies`,
      admin,
      body({ rules: [usdcCap('1.0000001')] }),
    ).expect(422);
    expect(res.body).toMatchObject({
      code: 'invalid_rules',
      errors: [
        { path: 'rules.0.caps.0.maxAmount', reason: expect.any(String) },
      ],
    });
    expect(await get(`${orgA}/policies`, admin).expect(200)).toHaveProperty(
      'body',
      [],
    );
  });

  it('rejects an unknown token, a second rule of one kind and a duplicate cap with paths', async () => {
    const unknown = await write(
      'post',
      `${orgA}/policies`,
      admin,
      body({
        rules: [
          {
            kind: 'amount_cap',
            capMode: 'per_transfer',
            caps: [{ chainId: '1', token: addr(0xdead), maxAmount: '1' }],
          },
        ],
      }),
    ).expect(422);
    expect(unknown.body.errors).toEqual([
      { path: 'rules.0.caps.0.token', reason: expect.any(String) },
    ]);

    const twice = await write(
      'post',
      `${orgA}/policies`,
      admin,
      body({
        rules: [{ kind: 'no_delegatecall' }, { kind: 'no_delegatecall' }],
      }),
    ).expect(422);
    expect(twice.body).toMatchObject({
      code: 'invalid_rules',
      errors: [{ path: 'rules.1.kind' }],
    });

    const dupCap = await write(
      'post',
      `${orgA}/policies`,
      admin,
      body({
        rules: [
          {
            kind: 'amount_cap',
            capMode: 'per_transfer',
            caps: [
              { chainId: '1', token: USDC, maxAmount: '1' },
              { chainId: '1', token: USDC.toLowerCase(), maxAmount: '2' },
            ],
          },
        ],
      }),
    ).expect(422);
    expect(dupCap.body.errors).toEqual([
      { path: 'rules.0.caps.1', reason: expect.any(String) },
    ]);
  });

  it('rejects a scope naming a Safe not linked to this org', async () => {
    await linkSafe(orgB, SAFE_A);
    const res = await write(
      'post',
      `${orgA}/policies`,
      admin,
      body({
        scope: { safes: [{ chainId: '1', address: SAFE_A }], chainIds: [] },
      }),
    ).expect(422);
    expect(res.body).toMatchObject({
      code: 'invalid_rules',
      errors: [{ path: 'scope.safes.0' }],
    });
  });

  it('keeps a Safe in scope after unlink and relink', async () => {
    await linkSafe(orgA, SAFE_A);
    const { id } = await create({
      scope: { safes: [{ chainId: '1', address: SAFE_A }], chainIds: [] },
    });
    const [stored] = await asOrg(orgA, (em) =>
      em.query(`SELECT scope FROM policy_versions WHERE policy_id = $1`, [id]),
    );
    expect(stored.scope.safes).toEqual([
      { chainId: '1', address: SAFE_A.toLowerCase() },
    ]);

    await unlinkSafe(orgA, SAFE_A);
    // an edit that keeps the stored (now unlinked) Safe is not rejected
    await write('put', `${orgA}/policies/${id}`, admin, {
      ...body({
        name: 'Renamed',
        scope: { safes: [{ chainId: '1', address: SAFE_A }], chainIds: [] },
      }),
      expectedVersion: 1,
    }).expect(200);
    await linkSafe(orgA, SAFE_A);

    const active = (
      address: Address,
      chainId = '1',
    ): Promise<Array<CompiledPolicy>> =>
      tx.runInOrgTx(
        (em) => context.activePolicies(em, orgA, { chainId, address }),
        orgA,
      );
    expect((await active(SAFE_A)).map((p) => p.id)).toEqual([id]);
    expect(await active(SAFE_A, '10')).toEqual([]);
    expect(await active(SAFE_B)).toEqual([]);
  });

  it('selects active in-scope policies at their latest version in creation order', async () => {
    const whole = await create({ name: 'Whole org' });
    const chain10 = await create({
      name: 'Chain 10',
      scope: { safes: [], chainIds: ['10'] },
    });
    const disabled = await create({ name: 'Off', enabled: false });
    await write('put', `${orgA}/policies/${whole.id}`, admin, {
      ...body({ name: 'Whole org', rules: [usdcCap('3')] }),
      expectedVersion: 1,
    }).expect(200);
    await create({ name: 'Gone' }).then(({ id }) =>
      write('delete', `${orgA}/policies/${id}`, admin).expect(204),
    );

    const policies = await tx.runInOrgTx(
      (em) =>
        context.activePolicies(em, orgA, { chainId: '10', address: SAFE_A }),
      orgA,
    );
    expect(policies.map((p) => [p.id, p.version])).toEqual([
      [whole.id, 2],
      [chain10.id, 1],
    ]);
    expect(policies[0].rules).toEqual([
      {
        kind: 'amount_cap',
        capMode: 'per_transfer',
        caps: [
          {
            chainId: '1',
            token: USDC.toLowerCase(),
            maxRaw: '3000000',
            decimals: 6,
            symbol: 'USDC',
          },
        ],
      },
    ]);
    expect(policies.map((p) => p.id)).not.toContain(disabled.id);
  });

  it('allows only 20 policies when two creates race', async () => {
    for (let i = 0; i < 19; i++) await create({ name: `p${i}` });
    const [a, b] = await Promise.all([
      write('post', `${orgA}/policies`, admin, body({ name: 'race-a' })),
      write('post', `${orgA}/policies`, admin, body({ name: 'race-b' })),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect([a, b].find((r) => r.status === 409)?.body.code).toBe(
      'policy_limit',
    );
    const listed = await get(`${orgA}/policies`, admin).expect(200);
    expect(listed.body).toHaveLength(20);
  });

  it('answers 409 policy_exists for a name taken in the org', async () => {
    await create({ name: 'Ops' });
    const res = await write(
      'post',
      `${orgA}/policies`,
      admin,
      body({ name: 'ops' }),
    ).expect(409);
    expect(res.body.code).toBe('policy_exists');
  });

  it('serves policy findings to a member with policies.view and answers 404 across orgs', async () => {
    await linkSafe(orgA, SAFE_A);
    await linkSafe(orgB, SAFE_B);
    const [{ id: linkedA }] = await sql.query(
      `SELECT id FROM linked_safes WHERE org_id = $1 AND address = $2`,
      [orgA, SAFE_A],
    );
    const [{ id: linkedB }] = await sql.query(
      `SELECT id FROM linked_safes WHERE org_id = $1 AND address = $2`,
      [orgB, SAFE_B],
    );
    await asOrg(orgA, (em) =>
      em.query(
        `INSERT INTO policy_findings (org_id, linked_safe_id, chain_id, safe_address, safe_tx_hash, nonce, evaluation_hash, violations)
         VALUES ($1, $2, '1', $3, $4, 7, 'h', '[]')`,
        [orgA, linkedA, SAFE_A, `0x${'ab'.repeat(32)}`],
      ),
    );

    const { body: list } = await get(
      `${orgA}/policy-findings?linkedSafeId=${linkedA}`,
      member,
    ).expect(200);
    expect(list).toEqual([
      expect.objectContaining({
        linkedSafeId: linkedA,
        safeAddress: SAFE_A,
        nonce: '7',
        resolvedAt: null,
        firstSeenAt: expect.any(String),
      }),
    ]);
    await get(`${orgA}/policy-findings?linkedSafeId=${linkedB}`, admin).expect(
      404,
    );
    await get(`${orgA}/policy-findings?status=bogus`, admin).expect(400);
    await get(`${orgA}/policy-findings`, adminB).expect(404);
    expect(
      (await get(`${orgB}/policy-findings?status=all`, adminB).expect(200))
        .body,
    ).toEqual([]);
  });

  it('answers 404 for a policy id of another org', async () => {
    const { id } = await create();
    await write('put', `${orgB}/policies/${id}`, adminB, {
      ...body({ name: 'x' }),
      expectedVersion: 1,
    }).expect(404);
    await write('delete', `${orgB}/policies/${id}`, adminB).expect(404);
    await write('delete', `${orgB}/policies/not-a-uuid`, adminB).expect(404);
    expect(await get(`${orgB}/policies`, adminB).expect(200)).toHaveProperty(
      'body',
      [],
    );
    // and B's admin is not a member of A
    await get(`${orgA}/policies`, adminB).expect(404);
  });

  it('bumps the version and config hash on a rule change and not on a no-op save', async () => {
    const first = await create({ rules: [usdcCap('10')] });
    const same = await write('put', `${orgA}/policies/${first.id}`, admin, {
      ...body({ rules: [usdcCap('10')] }),
      expectedVersion: 1,
    }).expect(200);
    expect(same.body).toMatchObject({
      version: 1,
      configHash: first.configHash,
    });
    expect(await events('policy.updated')).toHaveLength(0);

    const changed = await write('put', `${orgA}/policies/${first.id}`, admin, {
      ...body({ rules: [usdcCap('10.000001')] }),
      expectedVersion: 1,
    }).expect(200);
    expect(changed.body.version).toBe(2);
    expect(changed.body.configHash).not.toBe(first.configHash);
    const [ev] = await events('policy.updated');
    expect(ev.payload).toEqual({ name: 'Payments', version: 2 });

    const disabled = await write('put', `${orgA}/policies/${first.id}`, admin, {
      ...body({ enabled: false, rules: [usdcCap('10.000001')] }),
      expectedVersion: 2,
    }).expect(200);
    expect(disabled.body).toMatchObject({
      version: 3,
      status: 'disabled',
      configHash: changed.body.configHash,
    });

    await write('delete', `${orgA}/policies/${first.id}`, admin).expect(204);
    const [del] = await events('policy.deleted');
    expect(del.payload).toEqual({ name: 'Payments' });
    expect(await get(`${orgA}/policies`, admin).expect(200)).toHaveProperty(
      'body',
      [],
    );
    // versions are kept for finding history
    const versions = await asOrg(orgA, (em) =>
      em.query(
        `SELECT version FROM policy_versions WHERE policy_id = $1 ORDER BY version`,
        [first.id],
      ),
    );
    expect(
      (versions as Array<{ version: number }>).map((v) => v.version),
    ).toEqual([1, 2, 3]);
    await write('put', `${orgA}/policies/${first.id}`, admin, {
      ...body(),
      expectedVersion: 3,
    }).expect(404);
  });

  it('answers 409 version_conflict on a stale expectedVersion', async () => {
    const { id } = await create();
    await write('put', `${orgA}/policies/${id}`, admin, {
      ...body({ name: 'v2' }),
      expectedVersion: 1,
    }).expect(200);
    const res = await write('put', `${orgA}/policies/${id}`, admin, {
      ...body({ name: 'v3' }),
      expectedVersion: 1,
    }).expect(409);
    expect(res.body.code).toBe('version_conflict');
  });

  it('answers 409 version_conflict to a second editor submitting the same change from v1', async () => {
    const { id } = await create();
    const change = { ...body({ name: 'Same' }), expectedVersion: 1 };
    await write('put', `${orgA}/policies/${id}`, admin, change).expect(200);
    const res = await write(
      'put',
      `${orgA}/policies/${id}`,
      admin,
      change,
    ).expect(409);
    expect(res.body.code).toBe('version_conflict');
  });

  it('reuses stored cap metadata, so rename and disable work while the token service is down', async () => {
    const { id, configHash } = await create({ rules: [usdcCap('10')] });
    txService.getToken.mockRejectedValue(new Error('tx-service down'));
    const renamed = await write('put', `${orgA}/policies/${id}`, admin, {
      ...body({ name: 'Renamed', rules: [usdcCap('10.0')] }),
      expectedVersion: 1,
    }).expect(200);
    expect(renamed.body).toMatchObject({ version: 2, configHash });
    await write('put', `${orgA}/policies/${id}`, admin, {
      ...body({ name: 'Renamed', enabled: false, rules: [usdcCap('10')] }),
      expectedVersion: 2,
    }).expect(200);
    // a changed cap needs the token again
    await write('put', `${orgA}/policies/${id}`, admin, {
      ...body({ name: 'Renamed', enabled: false, rules: [usdcCap('11')] }),
      expectedVersion: 3,
    }).expect(502);
    // an upstream symbol change does not make a new version
    txService.getToken.mockResolvedValue({
      type: 'ERC20',
      address: USDC,
      decimals: 6,
      symbol: 'USDC.e',
      name: 'x',
    });
    const same = await write('put', `${orgA}/policies/${id}`, admin, {
      ...body({ name: 'Renamed', enabled: false, rules: [usdcCap('10')] }),
      expectedVersion: 3,
    }).expect(200);
    expect(same.body).toMatchObject({ version: 3, configHash });
    expect(same.body.rules[0].caps[0].symbol).toBe('USDC');
  });

  it('answers 422 invalid_rules for a malformed or oversized rules array and unknown token decimals', async () => {
    for (const rules of [
      'x',
      [],
      Array.from({ length: 9 }, () => ({ kind: 'no_delegatecall' })),
    ]) {
      const res = await write('post', `${orgA}/policies`, admin, {
        ...body(),
        rules,
      }).expect(422);
      expect(res.body).toMatchObject({
        code: 'invalid_rules',
        errors: [expect.objectContaining({ path: 'rules' })],
      });
    }
    txService.getToken.mockResolvedValue({
      type: 'ERC20',
      address: USDC,
      decimals: null,
      symbol: 'USDC',
      name: 'x',
    });
    const res = await write(
      'post',
      `${orgA}/policies`,
      admin,
      body({ rules: [usdcCap('1')] }),
    ).expect(422);
    expect(res.body.errors).toEqual([
      { path: 'rules.0.caps.0.token', reason: 'Token decimals unknown' },
    ]);
  });

  it('answers 403 when the writer is demoted while waiting for the org lock', async () => {
    const coAdmin = await signIn();
    const orgC = await createOrg([
      [admin, 'admin'],
      [coAdmin, 'admin'],
    ]);
    const { body: created } = await write(
      'post',
      `${orgC}/policies`,
      admin,
      body(),
    ).expect(201);
    const runner = sql.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await runner.query(
        `SELECT id FROM organizations WHERE id = $1 FOR UPDATE`,
        [orgC],
      );
      const pending = write('put', `${orgC}/policies/${created.id}`, admin, {
        ...body({ name: 'late' }),
        expectedVersion: 1,
      }).then((r) => r);
      // wait until the PUT is queued behind the org row lock
      for (let i = 0; i < 100; i++) {
        const [{ n }] = await sql.query(
          `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
        );
        if (n > 0) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      await runner.query(
        `UPDATE role_bindings SET role_id = (SELECT id FROM roles WHERE org_id IS NULL AND key = 'member')
          WHERE member_id = (SELECT id FROM members WHERE org_id = $1 AND user_id = $2)`,
        [orgC, admin.userId],
      );
      await runner.commitTransaction();
      expect((await pending).status).toBe(403);
    } finally {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      await runner.release();
    }
  });

  it('lets exactly one of two concurrent PUTs with the same expectedVersion win', async () => {
    const { id } = await create();
    const [a, b] = await Promise.all([
      write('put', `${orgA}/policies/${id}`, admin, {
        ...body({ name: 'A' }),
        expectedVersion: 1,
      }),
      write('put', `${orgA}/policies/${id}`, admin, {
        ...body({ name: 'B' }),
        expectedVersion: 1,
      }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const versions = await asOrg(orgA, (em) =>
      em.query(
        `SELECT version FROM policy_versions WHERE policy_id = $1 ORDER BY version`,
        [id],
      ),
    );
    expect(versions).toHaveLength(2);
  });

  it('builds trustedMultiSend from deployments and chain config', async () => {
    const ctx = await tx.runInOrgTx(
      async (em) =>
        context.context(em, orgA, '1', await context.trustedMultiSend('1')),
      orgA,
    );
    const expected = ['1.1.1', '1.3.0', '1.4.1']
      .flatMap((version) => [
        ...getMultiSendDeployments({ chainId: '1', version }),
        ...getMultiSendCallOnlyDeployments({ chainId: '1', version }),
      ])
      .map((a) => a.toLowerCase());
    expect(expected.length).toBeGreaterThan(2);
    for (const a of expected) expect(ctx.trustedMultiSend.has(a)).toBe(true);
    expect(ctx.trustedMultiSend.has(CUSTOM_MULTISEND.toLowerCase())).toBe(true);
    expect(ctx.trustedMultiSend.has(CUSTOM_CALL_ONLY.toLowerCase())).toBe(true);
    expect(ctx.chainId).toBe('1');
    expect(chainsRepo.getChain).toHaveBeenCalledWith('1');
    // custom addresses are kept but logged: they are not official deployments
    expect(logger.error).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining(CUSTOM_MULTISEND),
    );

    logger.error.mockClear();
    chainsRepo.getChain.mockResolvedValue({
      chainId: '1',
      contractAddresses: {
        multiSendAddress: getAddress(expected[0]),
        multiSendCallOnlyAddress: null,
      },
    });
    await context.trustedMultiSend('1');
    expect(logger.error).not.toHaveBeenCalled();

    chainsRepo.getChain.mockRejectedValue(new Error('config down'));
    await expect(context.trustedMultiSend('1')).rejects.toThrow('config down');
  });

  it('includes only contacts tagged allowed on the Safe chain', async () => {
    const seed = (
      org: string,
      name: string,
      address: Address,
      chainIds: Array<string>,
      tags: Array<string>,
    ): Promise<unknown> =>
      asOrg(org, (em) =>
        em.query(
          `INSERT INTO contacts (org_id, name, address, chain_ids, tags) VALUES ($1,$2,$3,$4,$5)`,
          [org, name, address, chainIds, tags],
        ),
      );
    await seed(orgA, 'ok', addr(1), ['1', '10'], ['allowed', 'vendor']);
    await seed(orgA, 'other chain', addr(2), ['10'], ['allowed']);
    await seed(orgA, 'untagged', addr(3), ['1'], ['vendor']);
    await seed(orgB, 'other org', addr(4), ['1'], ['allowed']);
    const ctx = await tx.runInOrgTx(
      async (em) =>
        context.context(em, orgA, '1', await context.trustedMultiSend('1')),
      orgA,
    );
    expect([...ctx.allowedRecipients]).toEqual([addr(1).toLowerCase()]);
  });
});
