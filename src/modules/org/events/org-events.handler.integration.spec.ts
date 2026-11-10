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
import { OrgEventsReconciler } from '@/modules/org/events/org-events.reconciler';
import { systemClock } from '@/modules/org/common/clock';
import { PurgeProcessor } from '@/modules/org/jobs/purge.processor';
import {
  seedSnapshotIfAbsent,
  toSnapshot,
} from '@/modules/org/events/safe-snapshot';
import { LinkedSafesService } from '@/modules/org/safes/linked-safes.service';
import type { Safe } from '@/modules/safe/domain/entities/safe.entity';
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
  let userA: string;

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
    const users: Array<string> = [];
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
        users.push(user.id as string);
        return org.id as string;
      });
    orgA = await createOrg('A');
    orgB = await createOrg('B');
    userA = users[0];
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

  describe('concurrency and seeding', () => {
    jest.setTimeout(20_000);
    const delayed = <T>(value: T, ms: number): Promise<T> =>
      new Promise((resolve) => setTimeout(() => resolve(value), ms));

    it('serialises two executed events of one Safe: no reversed diff (F1)', async () => {
      await seed(); // S0: threshold 2
      safeRepo.getSafe
        .mockImplementationOnce(() => delayed(safeState({ threshold: 1 }), 300))
        .mockImplementationOnce(() => delayed(safeState({ threshold: 3 }), 0));
      await Promise.all([
        handler.handle(executed()),
        handler.handle(executed()),
      ]);
      const pairs = (await events(orgA)).map((e) => [
        e.payload.from,
        e.payload.to,
      ]);
      expect(pairs.sort()).toEqual([
        [1, 3],
        [2, 1],
      ]);
    });

    it('a seed racing an execution neither errors nor overwrites (F2)', async () => {
      safeRepo.getSafe.mockResolvedValue(safeState({ threshold: 5 }));
      await Promise.all([
        handler.handle({
          ...executed(),
          type: TransactionEventType.PENDING_MULTISIG_TRANSACTION,
        } as Event),
        handler.handle(executed()),
      ]);
      expect(await events(orgA)).toEqual([]);
      const snap = await sql.query(
        `SELECT threshold FROM linked_safe_snapshots`,
      );
      expect(snap).toEqual([{ threshold: 5 }]);
    });

    it('seedSnapshotIfAbsent never overwrites an existing row (F2)', async () => {
      await seed();
      await sql.transaction((em) =>
        seedSnapshotIfAbsent(
          em,
          CHAIN,
          SAFE,
          toSnapshot(safeState({ threshold: 9 }) as Safe),
        ),
      );
      const snap = await sql.query(
        `SELECT threshold FROM linked_safe_snapshots`,
      );
      expect(snap).toEqual([{ threshold: 2 }]);
    });

    // The permission re-check is covered by the safes specs; here it always passes
    const allowLink = {
      effective: () =>
        Promise.resolve({ orgStatus: 'active', permissions: ['safes.link'] }),
    } as never;

    it('seeds at link time so the first change emits an event (F3)', async () => {
      await sql.query(`DELETE FROM linked_safes`);
      const service = new LinkedSafesService(
        new OrgTransaction(sql),
        new ActivityLog({} as FieldEncryptionService),
        {
          isSafe: jest.fn().mockResolvedValue(true),
          getSafe: safeRepo.getSafe,
          clearSafe: safeRepo.clearSafe,
        } as never,
        allowLink,
        logger as never,
      );
      safeRepo.getSafe.mockResolvedValueOnce(safeState());
      await service.link(
        orgA,
        { chainId: CHAIN, address: SAFE },
        { userId: userA },
      );

      safeRepo.getSafe.mockResolvedValueOnce(safeState({ owners: [O1, O3] }));
      await handler.handle(executed());
      expect((await events(orgA)).map((e) => e.type)).toContain(
        'onchain.owners_changed',
      );
    });

    it('does not fail the link when seeding fails (F3)', async () => {
      await sql.query(`DELETE FROM linked_safes`);
      const service = new LinkedSafesService(
        new OrgTransaction(sql),
        new ActivityLog({} as FieldEncryptionService),
        {
          isSafe: jest.fn().mockResolvedValue(true),
          getSafe: jest.fn().mockRejectedValue(new Error('node down')),
        } as never,
        allowLink,
        logger as never,
      );
      await expect(
        service.link(
          orgA,
          { chainId: CHAIN, address: SAFE },
          { userId: userA },
        ),
      ).resolves.toMatchObject({ address: SAFE });
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe('snapshot lifecycle on relink (item 8)', () => {
    const allowAll = {
      effective: () =>
        Promise.resolve({
          orgStatus: 'active',
          permissions: ['safes.link', 'safes.unlink'],
        }),
    } as never;
    const service = (): LinkedSafesService =>
      new LinkedSafesService(
        new OrgTransaction(sql),
        new ActivityLog({} as FieldEncryptionService),
        {
          isSafe: jest.fn().mockResolvedValue(true),
          getSafe: safeRepo.getSafe,
          clearSafe: safeRepo.clearSafe,
        } as never,
        allowAll,
        logger as never,
      );
    const snapshot = (): Promise<Array<{ owners: Array<string> }>> =>
      sql.query(`SELECT owners FROM linked_safe_snapshots`);

    it('link, unlink, owner change while unlinked, relink: no historic owner event', async () => {
      await sql.query(`DELETE FROM linked_safes`);
      safeRepo.getSafe.mockResolvedValue(safeState());
      const { id } = await service().link(
        orgA,
        { chainId: CHAIN, address: SAFE },
        { userId: userA },
      );
      await service().unlink(orgA, id, { userId: userA });

      // owners change while no org links the Safe: nobody records it
      safeRepo.getSafe.mockResolvedValue(safeState({ owners: [O1, O3] }));
      await handler.handle(executed());
      await service().link(
        orgA,
        { chainId: CHAIN, address: SAFE },
        { userId: userA },
      );
      // the next unrelated execution sees no owner change
      await handler.handle(executed());

      expect((await events(orgA)).map((e) => e.type)).toEqual([
        'safe.linked',
        'safe.linked',
        'safe.unlinked',
      ]);
    });

    it('deletes the snapshot on the last unlink only', async () => {
      await seed();
      const ids: Array<{ id: string; org_id: string }> = await sql.query(
        `SELECT id, org_id FROM linked_safes`,
      );
      const idOf = (org: string): string =>
        ids.find((r) => r.org_id === org)!.id;

      await service().unlink(orgA, idOf(orgA), { userId: userA });
      expect(await snapshot()).toHaveLength(1);
      await service().unlink(orgB, idOf(orgB), { userId: userA });
      expect(await snapshot()).toEqual([]);
    });

    it('overwrites a stale snapshot on link when no other org links the Safe', async () => {
      await sql.query(`DELETE FROM linked_safes`);
      await seedStale();
      safeRepo.getSafe.mockResolvedValue(safeState({ owners: [O1, O3] }));
      await service().link(
        orgA,
        { chainId: CHAIN, address: SAFE },
        { userId: userA },
      );
      expect(await snapshot()).toEqual([{ owners: [O1, O3] }]);
    });

    it('clears the cached Safe before reading the state it overwrites the snapshot with (round 2 item 8)', async () => {
      await sql.query(`DELETE FROM linked_safes`);
      await seedStale();
      safeRepo.getSafe.mockResolvedValue(safeState({ owners: [O1, O3] }));
      await service().link(
        orgA,
        { chainId: CHAIN, address: SAFE },
        { userId: userA },
      );
      expect(safeRepo.clearSafe).toHaveBeenCalledWith({
        chainId: CHAIN,
        address: SAFE,
      });
      expect(safeRepo.clearSafe.mock.invocationCallOrder[0]).toBeLessThan(
        safeRepo.getSafe.mock.invocationCallOrder[0],
      );
      expect(await snapshot()).toEqual([{ owners: [O1, O3] }]);
    });

    it('hourly purge deletes orphan snapshots no org links (round 2 item 8)', async () => {
      // SAFE is linked by orgs A and B; OTHER by nobody (aged); FRESH by
      // nobody but written just now, as a concurrent link would
      const FRESH = `0x${'f'.repeat(40)}`;
      for (const address of [SAFE, OTHER, FRESH]) {
        await sql.transaction((em) =>
          seedSnapshotIfAbsent(
            em,
            CHAIN,
            address,
            toSnapshot(safeState() as Safe),
          ),
        );
      }
      await sql.query(
        `UPDATE linked_safe_snapshots SET updated_at = now() - interval '11 minutes'
         WHERE address <> $1`,
        [FRESH],
      );
      await new PurgeProcessor(
        new OrgTransaction(sql),
        systemClock,
        logger as never,
      ).run();
      expect(
        await sql.query(
          `SELECT address FROM linked_safe_snapshots ORDER BY address`,
        ),
      ).toEqual(
        [{ address: SAFE }, { address: FRESH }].sort((a, b) =>
          a.address.localeCompare(b.address),
        ),
      );
    });

    it('keeps the snapshot other orgs diff against when one more org links', async () => {
      await sql.query(`DELETE FROM linked_safes WHERE org_id = $1`, [orgA]);
      await seedStale();
      safeRepo.getSafe.mockResolvedValue(safeState({ owners: [O1, O3] }));
      await service().link(
        orgA,
        { chainId: CHAIN, address: SAFE },
        { userId: userA },
      );
      expect(await snapshot()).toEqual([{ owners: [O1, O2] }]);
    });

    it('purge deletes the snapshots only the purged org linked', async () => {
      const [{ id: gone }] = await sql.query(
        `INSERT INTO organizations (name, status, deleted_at, purge_after)
         VALUES ('gone', 'deleted', now() - interval '31 days', now() - interval '1 day')
         RETURNING id`,
      );
      await sql.query(
        `INSERT INTO linked_safes (org_id, chain_id, address) VALUES ($1, $2, $3), ($1, $2, $4)`,
        [gone, CHAIN, SAFE, OTHER],
      );
      for (const address of [SAFE, OTHER]) {
        await sql.transaction((em) =>
          seedSnapshotIfAbsent(
            em,
            CHAIN,
            address,
            toSnapshot(safeState() as Safe),
          ),
        );
      }
      const purged = await new PurgeProcessor(
        new OrgTransaction(sql),
        systemClock,
        logger as never,
      ).purgeDue();

      expect(purged).toEqual([gone]);
      // SAFE is still linked by orgs A and B
      expect(
        await sql.query(`SELECT address FROM linked_safe_snapshots`),
      ).toEqual([{ address: SAFE }]);
    });

    async function seedStale(): Promise<void> {
      await sql.transaction((em) =>
        seedSnapshotIfAbsent(em, CHAIN, SAFE, toSnapshot(safeState() as Safe)),
      );
    }
  });

  describe('reconcile (final gate F1)', () => {
    let reconciler: OrgEventsReconciler;
    beforeAll(() => {
      reconciler = new OrgEventsReconciler(sql, handler, logger as never);
    });
    const snapshotThreshold = async (): Promise<Array<{ threshold: number }>> =>
      sql.query(
        `SELECT threshold FROM linked_safe_snapshots WHERE address = $1`,
        [SAFE],
      );

    it('emits a change the consumer missed, marked source reconcile, and skips a failing Safe', async () => {
      await seed(); // threshold 2
      await sql.query(
        `INSERT INTO linked_safes (org_id, chain_id, address) VALUES ($1, $2, $3)`,
        [orgA, CHAIN, OTHER],
      );
      safeRepo.getSafe.mockImplementation(({ address }: { address: string }) =>
        address.toLowerCase() === OTHER.toLowerCase()
          ? Promise.reject(new Error('node down'))
          : Promise.resolve(safeState({ threshold: 3 })),
      );

      expect(await reconciler.run()).toBe(2);

      for (const org of [orgA, orgB]) {
        expect(await events(org)).toEqual([
          {
            type: 'onchain.threshold_changed',
            payload: {
              chainId: CHAIN,
              address: SAFE,
              from: 2,
              to: 3,
              source: 'reconcile',
            },
          },
        ]);
      }
      expect(await snapshotThreshold()).toEqual([{ threshold: 3 }]);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'org_reconcile_safe_failed' }),
      );

      // nothing new on the next run
      await reconciler.run();
      expect(await events(orgA)).toHaveLength(1);
    });

    it('seeds a Safe whose link-time seed failed, then diffs it on a later run', async () => {
      safeRepo.getSafe.mockResolvedValueOnce(safeState());
      await reconciler.run();
      expect(await events(orgA)).toEqual([]);
      expect(await snapshotThreshold()).toEqual([{ threshold: 2 }]);

      safeRepo.getSafe.mockResolvedValueOnce(safeState({ owners: [O1, O3] }));
      await reconciler.run();
      expect((await events(orgA)).map((e) => e.type)).toEqual([
        'onchain.owners_changed',
      ]);
    });

    it('skips the run while another replica holds the run lock', async () => {
      const runner = sql.createQueryRunner();
      await runner.connect();
      try {
        await runner.query(`SELECT pg_advisory_lock(${0x6f7267}, 1)`);
        expect(await reconciler.run()).toBeNull();
        expect(safeRepo.getSafe).not.toHaveBeenCalled();
      } finally {
        await runner.query(`SELECT pg_advisory_unlock(${0x6f7267}, 1)`);
        await runner.release();
      }
    });
  });
});
