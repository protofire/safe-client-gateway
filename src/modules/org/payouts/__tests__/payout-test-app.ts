import { Module } from '@nestjs/common';
import type request from 'supertest';
import type { EntityManager } from 'typeorm';
import { getAddress, zeroAddress, type Address, type Hex } from 'viem';
import { DataSourceError } from '@/domain/errors/data-source.error';
import { ITransactionApiManager } from '@/domain/interfaces/transaction-api.manager.interface';
import { IBalancesRepository } from '@/modules/balances/domain/balances.repository.interface';
import { IChainsRepository } from '@/modules/chains/domain/chains.repository.interface';
import { CsvService } from '@/modules/csv-export/csv-utils/csv.service';
import { ActivityLog } from '@/modules/org/activity/activity-log.service';
import {
  createAuthTestApp,
  seedUser,
  type AuthTestApp,
} from '@/modules/org/auth/__tests__/auth-test-app';
import { multiSendCall } from '@/modules/org/common/__tests__/multisend.builder';
import { parseAmountStrict } from '@/modules/org/common/amounts';
import type { SafeCall } from '@/modules/org/common/multisend';
import { FieldEncryptionService } from '@/modules/org/crypto/field-encryption.service';
import { OrgTransaction } from '@/modules/org/db/org-transaction';
import { PermissionsModule } from '@/modules/org/permissions/permissions.module';
import { PolicyContextService } from '@/modules/org/policies/policy-context.service';
import { PayoutProposalsService } from '@/modules/org/payouts/payout-proposals.service';
import { PayoutRunsController } from '@/modules/org/payouts/payout-runs.controller';
import { PayoutRunsService } from '@/modules/org/payouts/payout-runs.service';
import { PayoutStatusUpdater } from '@/modules/org/payouts/payout-status.updater';
import type {
  PayoutRunDetail,
  StoredCall,
} from '@/modules/org/payouts/payout.schemas';
import { erc20TransferBuilder } from '@/modules/safe/domain/entities/__tests__/erc20-transfer.builder';
import { multisigTransactionBuilder } from '@/modules/safe/domain/entities/__tests__/multisig-transaction.builder';
import type { MultisigTransaction } from '@/modules/safe/domain/entities/multisig-transaction.entity';
import type { Transfer } from '@/modules/safe/domain/entities/transfer.entity';
import { ISafeRepository } from '@/modules/safe/domain/safe.repository.interface';

export const addr = (n: number): Address =>
  getAddress(`0x${n.toString(16).padStart(40, '0')}`);
export const CHAIN = '1';
export const SAFE_A = addr(0xa1);
export const SAFE_B = addr(0xb2);
export const USDC = getAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
export const ALICE = addr(0xa11ce);
export const BOB = addr(0xb0b);
export const CAROL = addr(0xca401);
export const CALL_ONLY = addr(0x3518);
export const HOUR = 3_600_000;

let hashSeq = 0;
const hex32 = (prefix: string): Hex =>
  `0x${prefix}${(++hashSeq).toString(16).padStart(64 - prefix.length, '0')}`;

/**
 * In-memory tx-service of every Safe: nonces, multisig txs and transfers.
 * The repository mock reads it like the gateway would.
 */
export class FakeChain {
  nonce = new Map<string, number>();
  txs: Array<MultisigTransaction> = [];
  transfers: Array<Transfer> = [];
  notDeployed = new Set<string>();
  failNonces = false;
  /** Server cap on transfers per page (below any `limit`); tests of the paging lower it. */
  pageSize = 100;
  /** Server cap on multisig txs per page. */
  txPageSize = 100;

  readonly repo = {
    getNonces: jest.fn(
      async (args: {
        safeAddress: Address;
      }): Promise<{ currentNonce: number; recommendedNonce: number }> => {
        const key = args.safeAddress.toLowerCase();
        if (this.notDeployed.has(key))
          throw new DataSourceError('Not Found', 404);
        if (this.failNonces) throw new DataSourceError('boom', 503);
        const current = this.nonce.get(key) ?? 5;
        const queued = this.txs
          .filter((t) => t.safe.toLowerCase() === key && !t.isExecuted)
          .map((t) => t.nonce + 1);
        return Promise.resolve({
          currentNonce: current,
          recommendedNonce: Math.max(current, ...queued),
        });
      },
    ),
    getMultiSigTransaction: jest.fn(
      (args: { safeTransactionHash: string }): Promise<MultisigTransaction> => {
        const tx = this.txs.find(
          (t) =>
            t.safeTxHash.toLowerCase() ===
            args.safeTransactionHash.toLowerCase(),
        );
        return tx
          ? Promise.resolve(structuredClone(tx))
          : Promise.reject(new DataSourceError('Not Found', 404));
      },
    ),
    // ordering -nonce, then insertion order; pages capped at txPageSize
    getMultisigTransactions: jest.fn(
      (args: {
        safeAddress: Address;
        nonce?: string;
        nonceGte?: number;
        executed?: boolean;
        trusted?: boolean;
        limit?: number;
        offset?: number;
      }) => {
        const all = this.txs
          .filter(
            (t) =>
              t.safe.toLowerCase() === args.safeAddress.toLowerCase() &&
              (args.nonce === undefined || String(t.nonce) === args.nonce) &&
              (args.nonceGte === undefined || t.nonce >= args.nonceGte) &&
              (args.executed === undefined || t.isExecuted === args.executed) &&
              // the gateway repository reads trusted txs unless told otherwise
              (args.trusted === false || t.trusted),
          )
          .sort((a, b) => b.nonce - a.nonce);
        const size = Math.min(args.limit ?? 20, this.txPageSize);
        const offset = args.offset ?? 0;
        return Promise.resolve({
          count: all.length,
          next: offset + size < all.length ? 'next' : null,
          previous: null,
          results: structuredClone(all.slice(offset, offset + size)),
        });
      },
    ),
    getTransfers: jest.fn(
      (args: {
        safeAddress: Address;
        transactionHash?: string;
        limit?: number;
        offset?: number;
      }) => {
        // the server filter is not trusted: the fake ignores it like a server without it
        const all = this.transfers.filter(
          (t) =>
            t.from.toLowerCase() === args.safeAddress.toLowerCase() ||
            t.to.toLowerCase() === args.safeAddress.toLowerCase(),
        );
        const offset = args.offset ?? 0;
        const results = all.slice(offset, offset + this.pageSize);
        return Promise.resolve({
          count: all.length,
          next: offset + this.pageSize < all.length ? 'next' : null,
          previous: null,
          results: structuredClone(results),
        });
      },
    ),
    clearSafe: jest.fn().mockResolvedValue(undefined),
    clearMultisigTransactions: jest.fn().mockResolvedValue(undefined),
    clearMultisigTransaction: jest.fn().mockResolvedValue(undefined),
    clearTransfers: jest.fn().mockResolvedValue(undefined),
  };

  reset(): void {
    this.nonce.clear();
    this.txs = [];
    this.transfers = [];
    this.notDeployed.clear();
    this.failNonces = false;
    this.pageSize = 100;
    this.txPageSize = 100;
  }

  setNonce(safe: Address, nonce: number): void {
    this.nonce.set(safe.toLowerCase(), nonce);
  }

  /** A queued tx of the Safe carrying `calls` as the UI would build them. */
  propose(
    safe: Address,
    nonce: number,
    calls: ReadonlyArray<SafeCall>,
    over: Partial<MultisigTransaction> = {},
  ): MultisigTransaction {
    const outer =
      calls.length === 1 ? calls[0] : multiSendCall(CALL_ONLY, calls);
    const tx: MultisigTransaction = {
      ...multisigTransactionBuilder()
        .with('safe', safe)
        .with('nonce', nonce)
        .with('to', outer.to)
        .with('value', outer.value.toString())
        .with('data', outer.data)
        .with('operation', outer.operation)
        .with('gasPrice', '0')
        .with('gasToken', zeroAddress)
        .with('refundReceiver', zeroAddress)
        .with('safeTxGas', 0)
        .with('trusted', true)
        .with('isExecuted', false)
        .with('isSuccessful', null)
        .with('executionDate', null)
        .with('transactionHash', null)
        .with('safeTxHash', hex32('5a'))
        .build(),
      ...over,
    };
    this.txs.push(tx);
    return tx;
  }

  /** Executes `tx` on-chain: nonce consumed, `ago` ms in the past by default old enough for the reorg margin. */
  execute(
    tx: MultisigTransaction,
    opts: { ago?: number; success?: boolean } = {},
  ): Hex {
    const transactionHash = hex32('e0');
    Object.assign(tx, {
      isExecuted: true,
      isSuccessful: opts.success ?? true,
      executionDate: new Date(Date.now() - (opts.ago ?? HOUR)),
      transactionHash,
    });
    const key = tx.safe.toLowerCase();
    this.nonce.set(key, Math.max(this.nonce.get(key) ?? 5, tx.nonce + 1));
    return transactionHash;
  }

  /** The ERC20 transfer records the tx-service indexes for the run's token items. */
  indexTransfers(
    safe: Address,
    transactionHash: string,
    items: PayoutRunDetail['items'],
  ): void {
    for (const i of items) {
      if (i.token === 'native') continue;
      this.transfers.push(
        erc20TransferBuilder()
          .with('from', safe)
          .with('to', getAddress(i.recipient))
          .with('tokenAddress', getAddress(i.token))
          .with('value', parseAmountStrict(i.amount, i.decimals).toString())
          .with('transactionHash', transactionHash as Hex)
          .build() as Transfer,
      );
    }
  }
}

export const toCalls = (calls: ReadonlyArray<StoredCall>): Array<SafeCall> =>
  calls.map((c) => ({
    to: getAddress(c.to),
    value: BigInt(c.value),
    data: c.data as Hex,
    operation: 0,
  }));

export type User = { userId: string; cookie: string };
export type Row = {
  address: string;
  amount: string;
  token: string;
  name?: string;
};

export type PayoutTestApp = {
  t: AuthTestApp;
  chain: FakeChain;
  updater: PayoutStatusUpdater;
  chainsRepo: { getChain: jest.Mock };
  /** Called by `reset()`, before each test. */
  reset(): Promise<void>;
  user(): Promise<User>;
  createOrg(users: Array<[User, 'admin' | 'member']>): Promise<string>;
  linkSafe(org: string, address: Address): Promise<string>;
  asOrg<T>(org: string, fn: (em: EntityManager) => Promise<T>): Promise<T>;
  write(
    method: 'post' | 'patch' | 'delete',
    path: string,
    who: User,
    body?: object,
  ): request.Test;
  get(path: string, who: User): request.Test;
  events(
    type: string,
  ): Promise<Array<{ payload: Record<string, unknown>; org_id: string }>>;
  /** Run row straight from the DB (no HTTP, no balances). */
  runRow(org: string, runId: string): Promise<Record<string, unknown>>;
  watchRows(): Promise<Array<{ run_id: string; org_id: string }>>;
  createRun(
    org: string,
    linkedSafeId: string,
    who: User,
    rows?: Array<Row>,
  ): Promise<PayoutRunDetail>;
  detail(org: string, runId: string, who: User): Promise<PayoutRunDetail>;
  build(org: string, runId: string, who: User): Promise<PayoutRunDetail>;
  claim(
    org: string,
    runId: string,
    who: User,
    body?: { expectedVersion?: number; nonce?: number | string },
  ): request.Test;
  report(
    org: string,
    runId: string,
    who: User,
    body: { attemptId: string; expectedVersion?: number; safeTxHash: string },
  ): request.Test;
  release(
    org: string,
    runId: string,
    attemptId: string,
    who: User,
  ): request.Test;
};

export const ROWS: Array<Row> = [
  { address: ALICE, amount: '1.5', token: 'native', name: 'Alice' },
  { address: BOB, amount: '1000.5', token: USDC },
];

export async function createPayoutTestApp(
  redisDb: number,
): Promise<PayoutTestApp> {
  const chain = new FakeChain();
  const chainsRepo = { getChain: jest.fn() };
  const txService = { getToken: jest.fn() };
  const txApiManager = { getApi: jest.fn() };
  const balancesRepo = { getBalances: jest.fn() };

  @Module({
    imports: [PermissionsModule],
    controllers: [PayoutRunsController],
    providers: [
      OrgTransaction,
      ActivityLog,
      FieldEncryptionService,
      PayoutRunsService,
      PayoutProposalsService,
      PayoutStatusUpdater,
      PolicyContextService,
      CsvService,
      { provide: IChainsRepository, useValue: chainsRepo },
      { provide: ITransactionApiManager, useValue: txApiManager },
      { provide: IBalancesRepository, useValue: balancesRepo },
      { provide: ISafeRepository, useValue: chain.repo },
    ],
  })
  class PayoutTestModule {}

  const t = await createAuthTestApp({
    redisDb,
    imports: [PayoutTestModule],
    config: {
      'org.encryption.keys': JSON.stringify({
        current: 'v1',
        keys: { v1: Buffer.alloc(32, 7).toString('base64') },
      }),
    },
  });
  const updater = t.app.get(PayoutStatusUpdater);
  // tests call the updater directly; a background run would race them
  updater.onModuleDestroy();

  const asOrg = <T>(
    org: string,
    fn: (em: EntityManager) => Promise<T>,
  ): Promise<T> =>
    t.sql.transaction(async (em) => {
      await em.query(`SELECT set_config('app.org_id', $1, true)`, [org]);
      return fn(em);
    });

  const orgs: Array<string> = [];
  let ipSeq = 0;

  const write: PayoutTestApp['write'] = (method, path, who, body) =>
    t
      .http()
      [method](`/v1/orgs/${path}`)
      .set('Cookie', who.cookie)
      .set('X-Org-Request', '1')
      .set(
        'X-Forwarded-For',
        `10.8.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`,
      )
      .timeout(15_000)
      .send(body);
  const get: PayoutTestApp['get'] = (path, who) =>
    t.http().get(`/v1/orgs/${path}`).set('Cookie', who.cookie).timeout(15_000);
  const detail = async (
    org: string,
    runId: string,
    who: User,
  ): Promise<PayoutRunDetail> =>
    (await get(`${org}/payout-runs/${runId}`, who).expect(200)).body;

  return {
    t,
    chain,
    updater,
    chainsRepo,
    asOrg,
    reset: async (): Promise<void> => {
      jest.clearAllMocks();
      chain.reset();
      for (const org of orgs) {
        await asOrg(org, async (em) => {
          await em.query(`DELETE FROM payout_runs`);
          await em.query(`DELETE FROM policies`);
        });
      }
      await t.sql.query(`DELETE FROM linked_safes`);
      await t.sql.query(`DELETE FROM activity_events`);
      await t.reset();
      chainsRepo.getChain.mockResolvedValue({
        chainId: CHAIN,
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        contractAddresses: {
          multiSendAddress: null,
          multiSendCallOnlyAddress: CALL_ONLY,
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
      balancesRepo.getBalances.mockResolvedValue([]);
    },
    user: () => seedUser(t.sql),
    createOrg: (users): Promise<string> =>
      t.sql.transaction(async (em) => {
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
        orgs.push(id as string);
        return id as string;
      }),
    linkSafe: async (org, address): Promise<string> =>
      (
        await t.sql.query(
          `INSERT INTO linked_safes (org_id, chain_id, address) VALUES ($1, $2, $3) RETURNING id`,
          [org, CHAIN, address],
        )
      )[0].id,
    write,
    get,
    detail,
    createRun: async (org, linkedSafeId, who, rows = ROWS) =>
      (
        await write('post', `${org}/payout-runs`, who, {
          linkedSafeId,
          name: 'March',
          rows,
        }).expect(201)
      ).body,
    build: async (org, runId, who): Promise<PayoutRunDetail> => {
      const { run } = await detail(org, runId, who);
      return (
        await write('post', `${org}/payout-runs/${runId}/build`, who, {
          expectedVersion: run.version,
        }).expect(200)
      ).body;
    },
    claim: (org, runId, who, body = {}) =>
      write('post', `${org}/payout-runs/${runId}/proposal-attempts`, who, body),
    report: (org, runId, who, body) =>
      write('post', `${org}/payout-runs/${runId}/proposed`, who, body),
    release: (org, runId, attemptId, who) =>
      write(
        'post',
        `${org}/payout-runs/${runId}/proposal-attempts/${attemptId}/release`,
        who,
      ),
    events: (type) =>
      t.sql.query(
        `SELECT org_id, payload FROM activity_events WHERE type = $1 ORDER BY created_at, id`,
        [type],
      ),
    runRow: (org, runId) =>
      asOrg(
        org,
        async (em) =>
          (
            await em.query(
              `SELECT status, version, pinned_nonce::text AS pinned_nonce, safe_tx_hash, nonce::text AS nonce,
                      executed_tx_hash, verifying_since, delay_notified_at, review, evaluation
                 FROM payout_runs WHERE id = $1`,
              [runId],
            )
          )[0],
      ),
    watchRows: () =>
      t.sql.query(`SELECT run_id, org_id FROM payout_watch ORDER BY run_id`),
  };
}
