import { NotFoundException } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';
import type { PostgresDriver } from 'typeorm/driver/postgres/PostgresDriver';
import { getAddress, type Address } from 'viem';
import { DataSourceError } from '@/domain/errors/data-source.error';
import { ActivityLog } from '@/modules/org/activity/activity-log.service';
import type { FieldEncryptionService } from '@/modules/org/crypto/field-encryption.service';
import {
  createOrgTestDb,
  type OrgTestDb,
} from '@/modules/org/db/__tests__/org-test-db';
import { OrgTransaction } from '@/modules/org/db/org-transaction';
import { configHash } from '@/modules/org/policies/config-hash';
import { FindingsController } from '@/modules/org/policies/findings.controller';
import { PolicyContextService } from '@/modules/org/policies/policy-context.service';
import type { PolicyRule } from '@/modules/org/policies/policy-rules';
import { PolicyScanner } from '@/modules/org/policies/policy-scanner';
import { runOrgMigrations } from '@/org-migrate';

const addr = (n: number): Address =>
  getAddress(`0x${n.toString(16).padStart(40, '0')}`);
const CHAIN = '11155111';
const RECIPIENT = addr(0xbeef);
// no contacts are tagged allowed: every native send > 0 is a violation
const ALLOWLIST: Array<PolicyRule> = [
  { kind: 'recipients_allowlist', tag: 'allowed' },
];
const NATIVE_CAP_5_CAP = {
  chainId: CHAIN,
  token: 'native' as const,
  maxRaw: '5',
  decimals: 18,
  symbol: 'ETH',
};
const NATIVE_CAP_5 = [
  {
    kind: 'amount_cap' as const,
    capMode: 'per_transfer' as const,
    caps: [NATIVE_CAP_5_CAP],
  },
];

const logger = {
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
};
const chainsRepo = {
  getChain: jest.fn().mockResolvedValue({ contractAddresses: {} }),
};

type Tx = {
  safe: Address;
  to: Address;
  value: string;
  data: null;
  operation: 0;
  nonce: number;
  safeTxHash: string;
  isExecuted: boolean;
  trusted: boolean;
};

describe('PolicyScanner', () => {
  let db: OrgTestDb;
  let sql: DataSource;
  let scanner: PolicyScanner;
  let findingsApi: FindingsController;
  let orgTx: OrgTransaction;
  let safeSeq = 0x5000;
  let hashSeq = 0;

  // per test: a fresh Safe, its queue and direct reads
  let SAFE: Address;
  let queue: Array<Tx>;
  let direct: Map<string, Tx | Error>;
  const safeRepo = {
    getSafe: jest.fn(),
    getTransactionQueue: jest.fn(),
    getMultiSigTransaction: jest.fn(),
  };

  const tx = (value: string, over: Partial<Tx> = {}): Tx => ({
    safe: SAFE,
    to: RECIPIENT,
    value,
    data: null,
    operation: 0,
    nonce: 10 + queue.length,
    safeTxHash: `0x${(++hashSeq).toString(16).padStart(64, 'a')}`,
    isExecuted: false,
    trusted: true,
    ...over,
  });

  const asOrg = <T>(
    org: string,
    fn: (em: EntityManager) => Promise<T>,
  ): Promise<T> =>
    sql.transaction(async (em) => {
      await em.query(`SELECT set_config('app.org_id', $1, true)`, [org]);
      return fn(em);
    });

  // the last-admin trigger needs an admin in the same transaction
  const newOrg = (): Promise<string> =>
    sql.transaction(async (em) => {
      const [org] = await em.query(
        `INSERT INTO organizations (name) VALUES ('org') RETURNING id`,
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
  const link = async (org: string): Promise<string> =>
    (
      await sql.query(
        `INSERT INTO linked_safes (org_id, chain_id, address) VALUES ($1, $2, $3) RETURNING id`,
        [org, CHAIN, SAFE],
      )
    )[0].id;
  const addPolicy = (
    org: string,
    rules: Array<PolicyRule>,
    chainIds: Array<string> = [],
  ): Promise<string> =>
    asOrg(org, async (em) => {
      const [{ id }] = await em.query(
        `INSERT INTO policies (org_id, name) VALUES ($1, $2) RETURNING id`,
        [org, `p${++hashSeq}`],
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
  const bumpPolicy = (
    org: string,
    id: string,
    rules: Array<PolicyRule>,
  ): Promise<void> =>
    asOrg(org, async (em) => {
      const [[{ current_version }]] = await em.query(
        `UPDATE policies SET current_version = current_version + 1 WHERE id = $1 RETURNING current_version`,
        [id],
      );
      const scope = { safes: [], chainIds: [] };
      await em.query(
        `INSERT INTO policy_versions (org_id, policy_id, version, scope, rules, config_hash)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          org,
          id,
          current_version,
          JSON.stringify(scope),
          JSON.stringify(rules),
          configHash(scope, rules),
        ],
      );
    });
  const setStatus = (org: string, id: string, status: string): Promise<void> =>
    asOrg(org, (em) =>
      em.query(`UPDATE policies SET status = $2 WHERE id = $1`, [id, status]),
    );
  const findings = (
    org: string,
  ): Promise<
    Array<{
      safe_tx_hash: string;
      resolved_at: Date | null;
      violations: Array<{ rule: string; policyVersion: number }>;
    }>
  > =>
    asOrg(org, (em) =>
      em.query(
        `SELECT safe_tx_hash, resolved_at, violations FROM policy_findings ORDER BY nonce`,
      ),
    );
  const open = async (org: string): Promise<Array<string>> =>
    (await findings(org))
      .filter((f) => f.resolved_at === null)
      .map((f) => f.safe_tx_hash);
  const logged = (
    org: string,
  ): Promise<Array<{ payload: Record<string, unknown> }>> =>
    sql.query(
      `SELECT payload FROM activity_events
        WHERE org_id = $1 AND type = 'policy.violation_found' ORDER BY created_at`,
      [org],
    );

  const deferred = <T>(): {
    promise: Promise<T>;
    resolve: (v: T) => void;
  } => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  };
  const insertFindings = (
    org: string,
    linkedSafeId: string,
    count: number,
  ): Promise<unknown> =>
    asOrg(org, (em) =>
      em.query(
        `INSERT INTO policy_findings
           (org_id, linked_safe_id, chain_id, safe_address, safe_tx_hash, nonce,
            evaluation_hash, violations, last_seen_at)
         SELECT $1, $2, $3, $4, '0x' || lpad(to_hex(i), 64, '0'), 10 + i, 'h', '[]',
                now() - make_interval(secs => ($5::int - i)::float8)
           FROM generate_series(1, $5::int) AS i`,
        [org, linkedSafeId, CHAIN, SAFE, count],
      ),
    );
  const pool = (): { totalCount: number; idleCount: number } =>
    (sql.driver as PostgresDriver).master;

  beforeAll(async () => {
    db = await createOrgTestDb();
    const owner = db.owner();
    await owner.initialize();
    await runOrgMigrations(owner, db.appUser);
    await owner.destroy();
    sql = db.app();
    await sql.initialize();
    orgTx = new OrgTransaction(sql);
    scanner = new PolicyScanner(
      sql,
      safeRepo as never,
      orgTx,
      new PolicyContextService(chainsRepo as never, logger as never),
      new ActivityLog({} as FieldEncryptionService),
      logger as never,
    );
    findingsApi = new FindingsController(orgTx);
  });

  afterAll(async () => {
    await sql?.destroy();
    await db?.drop();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    SAFE = addr(++safeSeq);
    queue = [];
    direct = new Map();
    safeRepo.getSafe.mockImplementation(() =>
      Promise.resolve({ address: SAFE, nonce: 10 }),
    );
    safeRepo.getTransactionQueue.mockImplementation(
      ({
        limit,
        offset,
        trusted,
      }: {
        limit: number;
        offset: number;
        trusted?: boolean;
      }) => {
        const visible = queue.filter((t) => !trusted || t.trusted);
        return Promise.resolve({
          count: visible.length,
          next: offset + limit < visible.length ? 'next' : null,
          previous: null,
          results: visible.slice(offset, offset + limit),
        });
      },
    );
    safeRepo.getMultiSigTransaction.mockImplementation(
      ({ safeTransactionHash }: { safeTransactionHash: string }) => {
        const found =
          direct.get(safeTransactionHash) ??
          queue.find((t) => t.safeTxHash === safeTransactionHash);
        if (found instanceof Error) return Promise.reject(found);
        if (!found)
          return Promise.reject(new DataSourceError('Not found', 404));
        return Promise.resolve(found);
      },
    );
  });

  it('records a finding and one activity event in each of two orgs linking the same Safe, by each org own policies', async () => {
    const [a, b] = [await newOrg(), await newOrg()];
    await link(a);
    await link(b);
    await addPolicy(a, ALLOWLIST);
    await addPolicy(b, NATIVE_CAP_5);
    const bad = tx('10');
    queue.push(bad, tx('0'));

    await scanner.scanSafe(CHAIN, SAFE);

    const [fa] = await findings(a);
    const [fb] = await findings(b);
    expect(fa.safe_tx_hash).toBe(bad.safeTxHash);
    expect(fa.violations.map((v) => v.rule)).toEqual(['recipients_allowlist']);
    expect(fb.violations.map((v) => v.rule)).toEqual(['amount_cap']);
    expect(await logged(a)).toHaveLength(1);
    expect(await logged(b)).toHaveLength(1);
    expect((await logged(a))[0].payload).toMatchObject({
      chainId: CHAIN,
      address: SAFE,
      safeTxHash: bad.safeTxHash,
      nonce: bad.nonce,
      rules: ['recipients_allowlist'],
    });
  });

  it('records nothing for an org whose policy scope excludes the Safe', async () => {
    const org = await newOrg();
    await link(org);
    await addPolicy(org, ALLOWLIST, ['1']);
    queue.push(tx('10'));

    await scanner.scanSafe(CHAIN, SAFE);

    expect(await findings(org)).toEqual([]);
    expect(await logged(org)).toEqual([]);
  });

  it('does not log again when the next run finds the same violations', async () => {
    const org = await newOrg();
    await link(org);
    await addPolicy(org, ALLOWLIST);
    queue.push(tx('10'));

    await scanner.scanSafe(CHAIN, SAFE);
    await scanner.scanSafe(CHAIN, SAFE);
    await scanner.scanTxs(CHAIN, SAFE, [queue[0].safeTxHash]);

    expect(await findings(org)).toHaveLength(1);
    expect(await logged(org)).toHaveLength(1);
  });

  it('does not log twice when an event scan and the timer scan race on one Safe', async () => {
    const org = await newOrg();
    await link(org);
    await addPolicy(org, ALLOWLIST);
    queue.push(tx('10'));

    await Promise.all([
      scanner.scanSafe(CHAIN, SAFE),
      scanner.scanTxs(CHAIN, SAFE, [queue[0].safeTxHash]),
      scanner.scanTxs(CHAIN, SAFE, [queue[0].safeTxHash]),
    ]);

    expect(await logged(org)).toHaveLength(1);
  });

  it('holds no DB connection while reading the queue', async () => {
    const org = await newOrg();
    await link(org);
    await addPolicy(org, ALLOWLIST);
    queue.push(tx('10'));
    const inUse: Array<number> = [];
    const record =
      (fn: (...args: Array<never>) => Promise<unknown>) =>
      (...args: Array<never>): Promise<unknown> => {
        inUse.push(pool().totalCount - pool().idleCount);
        return fn(...args);
      };
    safeRepo.getTransactionQueue.mockImplementation(
      record(safeRepo.getTransactionQueue.getMockImplementation()!),
    );
    safeRepo.getMultiSigTransaction.mockImplementation(
      record(safeRepo.getMultiSigTransaction.getMockImplementation()!),
    );

    await scanner.scanSafe(CHAIN, SAFE);
    await scanner.scanTxs(CHAIN, SAFE, [queue[0].safeTxHash]);

    expect(inUse.length).toBeGreaterThanOrEqual(2);
    expect(inUse.every((n) => n === 0)).toBe(true);
  });

  it('logs again when a new policy version changes the violations', async () => {
    const org = await newOrg();
    await link(org);
    const policy = await addPolicy(org, ALLOWLIST);
    queue.push(tx('10'));
    await scanner.scanSafe(CHAIN, SAFE);

    await bumpPolicy(org, policy, [...ALLOWLIST, ...NATIVE_CAP_5]);
    await scanner.scanSafe(CHAIN, SAFE);

    const [f] = await findings(org);
    expect(f.violations.map((v) => [v.rule, v.policyVersion])).toEqual([
      ['recipients_allowlist', 2],
      ['amount_cap', 2],
    ]);
    expect(await logged(org)).toHaveLength(2);
  });

  it('resolves a finding missed by a pass only after a direct read shows its tx executed or removed', async () => {
    const org = await newOrg();
    await link(org);
    await addPolicy(org, ALLOWLIST);
    const [executed, removed, stillQueued] = [tx('10'), tx('11'), tx('12')];
    queue.push(executed, removed, stillQueued);
    await scanner.scanSafe(CHAIN, SAFE);
    expect(await open(org)).toHaveLength(3);

    // all three vanish from the queue page (offsets shifted)
    queue = [];
    direct.set(executed.safeTxHash, { ...executed, isExecuted: true });
    direct.set(stillQueued.safeTxHash, stillQueued);
    await scanner.scanSafe(CHAIN, SAFE);

    expect(await open(org)).toEqual([stillQueued.safeTxHash]);
    expect(await logged(org)).toHaveLength(3);
  });

  it('keeps a missed finding open when the direct read fails', async () => {
    const org = await newOrg();
    await link(org);
    await addPolicy(org, ALLOWLIST);
    const t = tx('10');
    queue.push(t);
    await scanner.scanSafe(CHAIN, SAFE);

    queue = [];
    direct.set(t.safeTxHash, new DataSourceError('Bad gateway', 502));
    await scanner.scanSafe(CHAIN, SAFE);

    expect(await open(org)).toEqual([t.safeTxHash]);
  });

  it('resolves a finding whose tx was replaced at its nonce', async () => {
    const org = await newOrg();
    await link(org);
    await addPolicy(org, ALLOWLIST);
    const t = tx('10', { nonce: 10 });
    queue.push(t);
    await scanner.scanSafe(CHAIN, SAFE);

    // another tx executed at nonce 10: t stays unexecuted below the Safe nonce
    queue = [];
    safeRepo.getSafe.mockResolvedValue({ address: SAFE, nonce: 11 });
    direct.set(t.safeTxHash, t);
    await scanner.scanTxs(CHAIN, SAFE, [t.safeTxHash]);

    expect(await open(org)).toEqual([]);
  });

  it('resolves open findings when the last covering policy is deleted or disabled', async () => {
    const [a, b] = [await newOrg(), await newOrg()];
    await link(a);
    await link(b);
    const pa = await addPolicy(a, ALLOWLIST);
    const pb = await addPolicy(b, ALLOWLIST);
    queue.push(tx('10'));
    await scanner.scanSafe(CHAIN, SAFE);
    expect(await open(a)).toHaveLength(1);
    expect(await open(b)).toHaveLength(1);

    await setStatus(a, pa, 'deleted');
    await setStatus(b, pb, 'disabled');
    await scanner.scanSafe(CHAIN, SAFE);

    expect(await open(a)).toEqual([]);
    expect(await open(b)).toEqual([]);
  });

  it('keeps findings open when the queue read fails mid-pass', async () => {
    const org = await newOrg();
    await link(org);
    await addPolicy(org, ALLOWLIST);
    for (let i = 0; i < 40; i++) queue.push(tx('10'));
    await scanner.scanSafe(CHAIN, SAFE);
    expect(await open(org)).toHaveLength(40);

    const read = safeRepo.getTransactionQueue.getMockImplementation()!;
    safeRepo.getTransactionQueue.mockImplementation(
      (args: { offset: number }) =>
        args.offset >= 20
          ? Promise.reject(new DataSourceError('Bad gateway', 502))
          : read(args),
    );
    await expect(scanner.scanSafe(CHAIN, SAFE)).rejects.toThrow();

    expect(await open(org)).toHaveLength(40);
    const [state] = await sql.query(
      `SELECT next_offset, last_success_at, last_error_at FROM policy_scan_state
        WHERE chain_id = $1 AND address = $2`,
      [CHAIN, SAFE],
    );
    expect(state.next_offset).toBe(0);
    expect(state.last_success_at).toBeInstanceOf(Date);
    expect(state.last_error_at).toBeInstanceOf(Date);
  });

  it('continues the queue walk past the first 100 on the next scan', async () => {
    const org = await newOrg();
    await link(org);
    await addPolicy(org, ALLOWLIST);
    for (let i = 0; i < 120; i++) queue.push(tx(i === 110 ? '10' : '0'));

    await scanner.scanSafe(CHAIN, SAFE);
    expect(await open(org)).toEqual([]);

    await scanner.scanSafe(CHAIN, SAFE);
    expect(await open(org)).toEqual([queue[110].safeTxHash]);
    const [state] = await sql.query(
      `SELECT next_offset FROM policy_scan_state WHERE chain_id = $1 AND address = $2`,
      [CHAIN, SAFE],
    );
    expect(state.next_offset).toBe(0);
  });

  it('returns null from run while another replica holds the lock', async () => {
    const other = sql.createQueryRunner();
    await other.connect();
    try {
      await other.query(`SELECT pg_advisory_lock($1, $2)`, [0x6f7267, 2]);
      expect(await scanner.run()).toBeNull();
      await other.query(`SELECT pg_advisory_unlock($1, $2)`, [0x6f7267, 2]);
    } finally {
      await other.release();
    }
    const org = await newOrg();
    await link(org);
    expect(await scanner.run()).toBeGreaterThanOrEqual(1);
  });

  it('evaluates only the event-referenced tx and coalesces three events of one Safe into one scan', async () => {
    const org = await newOrg();
    await link(org);
    await addPolicy(org, ALLOWLIST);
    const [named, other] = [tx('10'), tx('10')];
    queue.push(named, other);

    await scanner.scanTxs(CHAIN, SAFE, [named.safeTxHash]);
    expect(await open(org)).toEqual([named.safeTxHash]);
    expect(safeRepo.getTransactionQueue).not.toHaveBeenCalled();

    const spy = jest.spyOn(scanner, 'scanTxs').mockResolvedValue();
    jest.useFakeTimers();
    try {
      scanner.enqueue(CHAIN, SAFE, named.safeTxHash);
      scanner.enqueue(CHAIN, SAFE, other.safeTxHash.toUpperCase());
      scanner.enqueue(CHAIN, SAFE, named.safeTxHash);
      expect(spy).not.toHaveBeenCalled();
      jest.advanceTimersByTime(2000);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(CHAIN, SAFE, [
        named.safeTxHash,
        other.safeTxHash.toLowerCase(),
      ]);
    } finally {
      jest.useRealTimers();
      spy.mockRestore();
    }
  });

  it('answers 404 for findings of another org', async () => {
    const [a, b] = [await newOrg(), await newOrg()];
    await link(a);
    const linkedB = await link(b);
    await addPolicy(a, ALLOWLIST);
    await addPolicy(b, ALLOWLIST);
    const t = tx('10');
    queue.push(t);
    await scanner.scanSafe(CHAIN, SAFE);

    await expect(
      findingsApi.list(a, { linkedSafeId: linkedB }),
    ).rejects.toBeInstanceOf(NotFoundException);
    const own = await findingsApi.list(b, { linkedSafeId: linkedB });
    expect(own).toEqual([
      expect.objectContaining({
        linkedSafeId: linkedB,
        chainId: CHAIN,
        safeAddress: SAFE,
        safeTxHash: t.safeTxHash,
        nonce: String(t.nonce),
        resolvedAt: null,
      }),
    ]);
    const ofA = await findingsApi.list(a, {});
    expect(ofA).toHaveLength(1);
    expect(ofA[0].linkedSafeId).not.toBe(linkedB);
  });
  it('scans only trusted proposals in the queue walk', async () => {
    const org = await newOrg();
    await link(org);
    await addPolicy(org, ALLOWLIST);
    queue.push(tx('10', { trusted: false }));

    await scanner.scanSafe(CHAIN, SAFE);

    expect(safeRepo.getTransactionQueue).toHaveBeenCalledWith(
      expect.objectContaining({ trusted: true }),
    );
    expect(await findings(org)).toEqual([]);
    expect(await logged(org)).toEqual([]);
  });

  it('neither creates nor resolves a finding for an untrusted tx named by an event', async () => {
    const org = await newOrg();
    await link(org);
    await addPolicy(org, ALLOWLIST);
    const untrusted = tx('10', { trusted: false });
    const known = tx('10');
    queue.push(known);
    await scanner.scanSafe(CHAIN, SAFE);
    direct.set(untrusted.safeTxHash, untrusted);
    direct.set(known.safeTxHash, {
      ...known,
      trusted: false,
      isExecuted: true,
    });

    await scanner.scanTxs(CHAIN, SAFE, [
      untrusted.safeTxHash,
      known.safeTxHash,
    ]);

    expect(await open(org)).toEqual([known.safeTxHash]);
    expect(await logged(org)).toHaveLength(1);
  });

  it('does not reopen a finding resolved while a queue page read was in flight', async () => {
    const org = await newOrg();
    await link(org);
    await addPolicy(org, ALLOWLIST);
    const t = tx('10');
    queue.push(t);
    await scanner.scanSafe(CHAIN, SAFE);
    expect(await logged(org)).toHaveLength(1);

    const read = safeRepo.getTransactionQueue.getMockImplementation()!;
    const held = deferred<void>();
    const reading = deferred<void>();
    safeRepo.getTransactionQueue.mockImplementationOnce(async (args: never) => {
      const page = read(args); // the stale page still lists t
      reading.resolve();
      await held.promise;
      return page;
    });
    const stale = scanner.scanSafe(CHAIN, SAFE);
    await reading.promise;
    direct.set(t.safeTxHash, { ...t, isExecuted: true });
    await scanner.scanTxs(CHAIN, SAFE, [t.safeTxHash]);
    expect(await open(org)).toEqual([]);
    held.resolve();
    await stale;

    expect(await open(org)).toEqual([]);
    expect(await logged(org)).toHaveLength(1);
  });

  it('rechecks at most the 100 oldest missed findings per pass', async () => {
    const org = await newOrg();
    const linked = await link(org);
    await addPolicy(org, ALLOWLIST);
    await insertFindings(org, linked, 150);
    // every direct read: executed
    safeRepo.getMultiSigTransaction.mockImplementation(
      ({ safeTransactionHash }: { safeTransactionHash: string }) =>
        Promise.resolve({
          ...tx('10'),
          safeTxHash: safeTransactionHash,
          isExecuted: true,
        }),
    );

    await scanner.scanSafe(CHAIN, SAFE);

    expect(safeRepo.getMultiSigTransaction).toHaveBeenCalledTimes(100);
    const left = await open(org);
    expect(left).toHaveLength(50);
    // the 50 most recently seen stay for the next pass
    expect(left).toContain(`0x${(150).toString(16).padStart(64, '0')}`);
  });

  it('writes at most 100 txs per transaction in scanTxs', async () => {
    const org = await newOrg();
    await link(org);
    await addPolicy(org, ALLOWLIST);
    const many = Array.from({ length: 150 }, () => tx('10'));
    many.forEach((t) => direct.set(t.safeTxHash, t));
    const spy = jest.spyOn(orgTx, 'runInOrgTx');
    try {
      await scanner.scanTxs(
        CHAIN,
        SAFE,
        many.map((t) => t.safeTxHash),
      );
      // one pre-check, then two write chunks
      expect(spy).toHaveBeenCalledTimes(3);
    } finally {
      spy.mockRestore();
    }
    expect(await open(org)).toHaveLength(150);
  });

  it('caps the pending hashes of one Safe at 500', () => {
    const spy = jest.spyOn(scanner, 'scanTxs').mockResolvedValue();
    jest.useFakeTimers();
    try {
      for (let i = 0; i < 600; i++) scanner.enqueue(CHAIN, SAFE, `0x${i}`);
      jest.advanceTimersByTime(2000);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][2]).toHaveLength(500);
    } finally {
      jest.useRealTimers();
      spy.mockRestore();
    }
  });

  it('reschedules events that arrive while a flush of the same Safe runs', async () => {
    const running = deferred<void>();
    const spy = jest
      .spyOn(scanner, 'scanTxs')
      .mockReturnValueOnce(running.promise)
      .mockResolvedValue();
    jest.useFakeTimers();
    try {
      scanner.enqueue(CHAIN, SAFE, '0x01');
      jest.advanceTimersByTime(2000);
      expect(spy).toHaveBeenCalledTimes(1);
      scanner.enqueue(CHAIN, SAFE, '0x02');
      scanner.enqueue(CHAIN, SAFE, '0x03');
      jest.advanceTimersByTime(5000);
      expect(spy).toHaveBeenCalledTimes(1);
      running.resolve();
      await jest.runOnlyPendingTimersAsync(); // settles the finally, no timer yet
      jest.advanceTimersByTime(2000);
      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy).toHaveBeenLastCalledWith(CHAIN, SAFE, ['0x02', '0x03']);
    } finally {
      jest.useRealTimers();
      spy.mockRestore();
    }
  });

  it('resolves open findings below the Safe nonce without reading each tx', async () => {
    const org = await newOrg();
    await link(org);
    await addPolicy(org, ALLOWLIST);
    const [a, b, c] = [
      tx('10', { nonce: 10 }),
      tx('10', { nonce: 11 }),
      tx('10', { nonce: 12 }),
    ];
    queue.push(a, b, c);
    await scanner.scanSafe(CHAIN, SAFE);
    expect(await open(org)).toHaveLength(3);

    safeRepo.getSafe.mockResolvedValue({ address: SAFE, nonce: 12 });
    direct.set(b.safeTxHash, { ...b, isExecuted: true });
    safeRepo.getMultiSigTransaction.mockClear();
    await scanner.scanTxs(CHAIN, SAFE, [b.safeTxHash]);

    expect(safeRepo.getMultiSigTransaction).toHaveBeenCalledTimes(1);
    expect(await open(org)).toEqual([c.safeTxHash]);
  });

  it('does not log again when only versions or unrelated policies change', async () => {
    const org = await newOrg();
    await link(org);
    const violated = await addPolicy(org, ALLOWLIST);
    const unrelated = await addPolicy(org, [
      { ...NATIVE_CAP_5[0], caps: [{ ...NATIVE_CAP_5_CAP, maxRaw: '1000' }] },
    ]);
    queue.push(tx('10'));
    await scanner.scanSafe(CHAIN, SAFE);

    await bumpPolicy(org, unrelated, [
      { ...NATIVE_CAP_5[0], caps: [{ ...NATIVE_CAP_5_CAP, maxRaw: '2000' }] },
    ]);
    await bumpPolicy(org, violated, ALLOWLIST); // e.g. a rename: new version, same rules
    await scanner.scanSafe(CHAIN, SAFE);

    expect(await logged(org)).toHaveLength(1);
    const [f] = await findings(org);
    expect(f.violations.map((v) => [v.rule, v.policyVersion])).toEqual([
      ['recipients_allowlist', 2],
    ]);
  });

  it('resolves findings of an org without covering policy before any upstream read', async () => {
    const org = await newOrg();
    await link(org);
    const policy = await addPolicy(org, ALLOWLIST);
    queue.push(tx('10'));
    await scanner.scanSafe(CHAIN, SAFE);
    await setStatus(org, policy, 'disabled');
    jest.clearAllMocks();
    const down = (): Promise<never> =>
      Promise.reject(new DataSourceError('Bad gateway', 502));
    safeRepo.getSafe.mockImplementation(down);
    safeRepo.getTransactionQueue.mockImplementation(down);
    safeRepo.getMultiSigTransaction.mockImplementation(down);

    await scanner.scanSafe(CHAIN, SAFE);
    await scanner.scanTxs(CHAIN, SAFE, [queue[0].safeTxHash]);

    expect(await open(org)).toEqual([]);
    expect(safeRepo.getSafe).not.toHaveBeenCalled();
    expect(safeRepo.getTransactionQueue).not.toHaveBeenCalled();
    expect(safeRepo.getMultiSigTransaction).not.toHaveBeenCalled();
    expect(chainsRepo.getChain).not.toHaveBeenCalled();
  });

  it('waits for the per-Safe lock before writing', async () => {
    const org = await newOrg();
    await link(org);
    await addPolicy(org, ALLOWLIST);
    queue.push(tx('10'));
    const other = sql.createQueryRunner();
    await other.connect();
    await other.startTransaction();
    try {
      await other.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `${CHAIN}:${SAFE.toLowerCase()}`,
      ]);
      let done = false;
      const scan = scanner.scanSafe(CHAIN, SAFE).then(() => (done = true));
      await new Promise((r) => setTimeout(r, 300));
      expect(done).toBe(false);
      expect(await findings(org)).toEqual([]);
      await other.commitTransaction();
      await scan;
    } finally {
      if (other.isTransactionActive) await other.rollbackTransaction();
      await other.release();
    }
    expect(await open(org)).toHaveLength(1);
  });

  it('returns every open finding and caps status=all at 1000', async () => {
    const org = await newOrg();
    const linked = await link(org);
    await insertFindings(org, linked, 1001);

    expect(await findingsApi.list(org, {})).toHaveLength(1001);
    expect(await findingsApi.list(org, { status: 'all' })).toHaveLength(1000);
  });
});
