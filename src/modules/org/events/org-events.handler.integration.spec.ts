import { getAddress, type Address } from 'viem';
import type { DataSource } from 'typeorm';
import { TransactionEventType } from '@/modules/hooks/routes/entities/event-type.entity';
import type { Event } from '@/modules/hooks/routes/entities/event.entity';
import { ActivityLog } from '@/modules/org/activity/activity-log.service';
import type { FieldEncryptionService } from '@/modules/org/crypto/field-encryption.service';
import {
  createOrgTestDb,
  type OrgTestDb,
} from '@/modules/org/db/__tests__/org-test-db';
import { OrgTransaction } from '@/modules/org/db/org-transaction';
import { OrgEventsHandler } from '@/modules/org/events/org-events.handler';
import { runOrgMigrations } from '@/org-migrate';

const addr = (n: number): Address =>
  getAddress(`0x${n.toString(16).padStart(40, '0')}`);
const SAFE = addr(0xa1);
const OTHER = addr(0xb2);
const ZERO = addr(0);
const CHAIN = '11155111';
const [O1, O2, O3] = [addr(1), addr(2), addr(3)];

const safeRepo = {
  getSafe: jest.fn(),
  clearSafe: jest.fn(),
  clearAllExecutedTransactions: jest.fn(),
  clearMultisigTransaction: jest.fn(),
  clearMultisigTransactions: jest.fn(),
  clearTransfers: jest.fn(),
  clearIncomingTransfers: jest.fn(),
  clearModuleTransactions: jest.fn(),
};
const balancesRepo = { clearBalances: jest.fn() };
const logger = {
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
};

const safeState = (over: Record<string, unknown> = {}): unknown => ({
  address: SAFE,
  nonce: 1,
  threshold: 2,
  owners: [O1, O2],
  masterCopy: addr(9),
  fallbackHandler: addr(8),
  guard: ZERO,
  modules: [],
  version: '1.3.0',
  ...over,
});

let n = 0;
const executed = (over: Record<string, unknown> = {}): Event =>
  ({
    type: TransactionEventType.EXECUTED_MULTISIG_TRANSACTION,
    chainId: CHAIN,
    address: SAFE,
    to: addr(7),
    safeTxHash: `0x${'1'.padStart(64, '0')}`,
    txHash: `0x${(++n).toString(16).padStart(64, '0')}`,
    failed: 'false',
    ...over,
  }) as Event;

describe('OrgEventsHandler', () => {
  let db: OrgTestDb;
  let sql: DataSource;
  let handler: OrgEventsHandler;
  let orgA: string;
  let orgB: string;

  const events = async (
    org: string,
  ): Promise<Array<{ type: string; payload: Record<string, unknown> }>> =>
    sql.query(
      `SELECT type, payload FROM activity_events WHERE org_id = $1 ORDER BY type`,
      [org],
    );
  const seed = async (state: unknown = safeState()): Promise<void> => {
    safeRepo.getSafe.mockResolvedValueOnce(state);
    await handler.handle({
      ...executed(),
      type: TransactionEventType.NEW_CONFIRMATION,
    } as Event);
  };

  beforeAll(async () => {
    db = await createOrgTestDb();
    const owner = db.owner();
    await owner.initialize();
    await runOrgMigrations(owner, db.appUser);
    await owner.destroy();
    sql = db.app();
    await sql.initialize();
    handler = new OrgEventsHandler(
      safeRepo as never,
      balancesRepo as never,
      new OrgTransaction(sql),
      new ActivityLog({} as FieldEncryptionService),
      logger as never,
    );
    const createOrg = (name: string): Promise<string> =>
      sql.transaction(async (em) => {
        const [org] = await em.query(
          `INSERT INTO organizations (name) VALUES ($1) RETURNING id`,
          [name],
        );
        const [user] = await em.query(
          `INSERT INTO users DEFAULT VALUES RETURNING id`,
        );
        const [member] = await em.query(
          `INSERT INTO members (org_id, user_id, status) VALUES ($1, $2, 'active') RETURNING id`,
          [org.id, user.id],
        );
        await em.query(
          `INSERT INTO role_bindings (member_id, role_id)
           SELECT $1, id FROM roles WHERE key = 'admin' AND org_id IS NULL`,
          [member.id],
        );
        return org.id as string;
      });
    orgA = await createOrg('A');
    orgB = await createOrg('B');
  });

  afterAll(async () => {
    await sql?.destroy();
    await db?.drop();
  });

  beforeEach(async () => {
    jest.resetAllMocks();
    await sql.query(`DELETE FROM activity_events`);
    await sql.query(`DELETE FROM linked_safes`);
    await sql.query(`DELETE FROM linked_safe_snapshots`);
    await sql.query(`DELETE FROM processed_events`);
    for (const org of [orgA, orgB]) {
      await sql.query(
        `INSERT INTO linked_safes (org_id, chain_id, address) VALUES ($1, $2, $3)`,
        [org, CHAIN, SAFE],
      );
    }
  });

  it('stores a snapshot on first sight without events', async () => {
    safeRepo.getSafe.mockResolvedValueOnce(safeState());
    await handler.handle(executed());
    expect(await events(orgA)).toEqual([]);
    const snap = await sql.query(`SELECT * FROM linked_safe_snapshots`);
    expect(snap).toHaveLength(1);
    expect(snap[0].threshold).toBe(2);
  });

  it('writes onchain.owners_changed to both orgs linking the Safe', async () => {
    await seed();
    safeRepo.getSafe.mockResolvedValueOnce(safeState({ owners: [O1, O3] }));
    await handler.handle(executed());
    for (const org of [orgA, orgB]) {
      const [e, ...rest] = await events(org);
      expect(rest).toEqual([]);
      expect(e.type).toBe('onchain.owners_changed');
      expect(e.payload).toMatchObject({
        chainId: CHAIN,
        address: SAFE,
        added: [O3],
        removed: [O2],
      });
    }
  });

  it('records threshold from/to', async () => {
    await seed();
    safeRepo.getSafe.mockResolvedValueOnce(safeState({ threshold: 1 }));
    await handler.handle(executed());
    expect((await events(orgA))[0]).toMatchObject({
      type: 'onchain.threshold_changed',
      payload: { from: 2, to: 1 },
    });
  });

  it('records modules enabled and disabled', async () => {
    await seed(safeState({ modules: [addr(5)] }));
    safeRepo.getSafe.mockResolvedValueOnce(safeState({ modules: [addr(6)] }));
    await handler.handle({
      type: TransactionEventType.MODULE_TRANSACTION,
      chainId: CHAIN,
      address: SAFE,
      module: addr(6),
      txHash: `0x${'f'.padStart(64, '0')}`,
    } as Event);
    expect((await events(orgA))[0]).toMatchObject({
      type: 'onchain.module_changed',
      payload: { enabled: [addr(6)], disabled: [addr(5)] },
    });
  });

  it('records guard change', async () => {
    await seed();
    safeRepo.getSafe.mockResolvedValueOnce(safeState({ guard: addr(4) }));
    await handler.handle(executed());
    expect((await events(orgA))[0]).toMatchObject({
      type: 'onchain.guard_changed',
      payload: { from: null, to: addr(4) },
    });
  });

  it('yields owner and threshold events for one batch (state diff)', async () => {
    await seed();
    safeRepo.getSafe.mockResolvedValueOnce(
      safeState({ owners: [O1, O2, O3], threshold: 3 }),
    );
    await handler.handle(executed());
    expect((await events(orgA)).map((e) => e.type)).toEqual([
      'onchain.owners_changed',
      'onchain.threshold_changed',
    ]);
  });

  it('ignores a duplicate delivery', async () => {
    await seed();
    const ev = executed();
    safeRepo.getSafe.mockResolvedValue(safeState({ threshold: 1 }));
    await handler.handle(ev);
    // a redelivery must not diff again, even if the chain state moved on
    safeRepo.getSafe.mockResolvedValue(safeState({ threshold: 3 }));
    await handler.handle(ev);
    expect(await events(orgA)).toHaveLength(1);
  });

  it('ignores Safes no org links', async () => {
    await sql.query(`DELETE FROM linked_safes`);
    await handler.handle(executed());
    expect(safeRepo.getSafe).not.toHaveBeenCalled();
    expect(await sql.query(`SELECT 1 FROM linked_safe_snapshots`)).toEqual([]);
  });

  it('ignores a failed execution', async () => {
    await seed();
    safeRepo.getSafe.mockResolvedValue(safeState({ threshold: 1 }));
    await handler.handle(executed({ failed: 'true' }));
    expect(await events(orgA)).toEqual([]);
  });

  it('does not touch another Safe', async () => {
    await seed();
    await handler.handle(executed({ address: OTHER }));
    expect(await events(orgA)).toEqual([]);
  });

  it('invalidates the caches on executed, confirmation and incoming events', async () => {
    const base = { chainId: CHAIN, address: SAFE };
    const args = { chainId: CHAIN, safeAddress: SAFE };
    await sql.query(`DELETE FROM linked_safes`);

    await handler.handle(executed());
    expect(safeRepo.clearSafe).toHaveBeenCalledWith({
      chainId: CHAIN,
      address: SAFE,
    });
    expect(safeRepo.clearAllExecutedTransactions).toHaveBeenCalledWith(args);
    expect(safeRepo.clearMultisigTransaction).toHaveBeenCalled();
    jest.clearAllMocks();

    await handler.handle({
      ...base,
      type: TransactionEventType.NEW_CONFIRMATION,
      owner: O1,
      safeTxHash: `0x${'2'.padStart(64, '0')}`,
    } as Event);
    expect(safeRepo.clearMultisigTransactions).toHaveBeenCalledWith(args);
    expect(safeRepo.clearMultisigTransaction).toHaveBeenCalled();
    jest.clearAllMocks();

    await handler.handle({
      ...base,
      type: TransactionEventType.INCOMING_ETHER,
      txHash: '0x1',
      value: '1',
    } as Event);
    expect(safeRepo.clearIncomingTransfers).toHaveBeenCalledWith(args);
    expect(balancesRepo.clearBalances).toHaveBeenCalledWith(args);
  });
});
