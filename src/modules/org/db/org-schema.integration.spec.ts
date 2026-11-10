import type { DataSource } from 'typeorm';
import {
  createOrgTestDb,
  type OrgTestDb,
} from '@/modules/org/db/__tests__/org-test-db';
import { OrgTransaction } from '@/modules/org/db/org-transaction';
import { runOrgMigrations } from '@/org-migrate';

const LAST_ADMIN = /must keep at least one active admin/;

describe('org schema (through the app login)', () => {
  let db: OrgTestDb;
  let owner: DataSource;
  let app: DataSource;
  let tx: OrgTransaction;
  let adminRoleId: string;
  let memberRoleId: string;

  beforeAll(async () => {
    db = await createOrgTestDb();
    owner = db.owner();
    await owner.initialize();
    await runOrgMigrations(owner, db.appUser);
    app = db.app();
    await app.initialize();
    tx = new OrgTransaction(app);
    [{ id: adminRoleId }] = await app.query(
      `SELECT id FROM roles WHERE key = 'admin' AND org_id IS NULL`,
    );
    [{ id: memberRoleId }] = await app.query(
      `SELECT id FROM roles WHERE key = 'member' AND org_id IS NULL`,
    );
  });

  afterAll(async () => {
    await app?.destroy();
    await owner?.destroy();
    await db?.drop();
  });

  /** An active org with `admins` active admin members; returns ids. */
  async function seedOrg(
    admins: number,
  ): Promise<{ orgId: string; memberIds: Array<string> }> {
    return app.transaction(async (em) => {
      const [{ id: orgId }]: Array<{ id: string }> = await em.query(
        `INSERT INTO organizations (name) VALUES ('org') RETURNING id`,
      );
      const memberIds: Array<string> = [];
      for (let i = 0; i < admins; i++)
        memberIds.push(await addAdmin(em, orgId));
      return { orgId, memberIds };
    });
  }

  async function adminCount(orgId: string): Promise<number> {
    const [{ n }] = await app.query(
      `SELECT count(*)::int AS n FROM members m
       JOIN role_bindings rb ON rb.member_id = m.id
       WHERE m.org_id = $1 AND m.status = 'active' AND rb.role_id = $2`,
      [orgId, adminRoleId],
    );
    return n;
  }

  /** Resolves once backend `pid` waits on a lock; throws after 2 s. */
  async function waitUntilLockWait(pid: number): Promise<void> {
    for (let i = 0; i < 40; i++) {
      const [row] = await app.query(
        `SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1`,
        [pid],
      );
      if (row?.wait_event_type === 'Lock') return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`backend ${pid} never waited on a lock`);
  }

  async function addAdmin(
    em: {
      query: (
        sql: string,
        params?: Array<unknown>,
      ) => Promise<Array<{ id: string }>>;
    },
    orgId: string,
  ): Promise<string> {
    const [{ id: userId }] = await em.query(
      `INSERT INTO users DEFAULT VALUES RETURNING id`,
    );
    const [{ id: memberId }] = await em.query(
      `INSERT INTO members (org_id, user_id, status) VALUES ($1, $2, 'active') RETURNING id`,
      [orgId, userId],
    );
    await em.query(
      `INSERT INTO role_bindings (member_id, role_id) VALUES ($1, $2)`,
      [memberId, adminRoleId],
    );
    return memberId;
  }

  describe('members_keep_one_admin', () => {
    it('rejects a commit that leaves an active org without an admin', async () => {
      const { orgId, memberIds } = await seedOrg(1);

      await expect(
        app.transaction((em) =>
          em.query(
            `UPDATE role_bindings SET role_id = $1 WHERE member_id = $2`,
            [memberRoleId, memberIds[0]],
          ),
        ),
      ).rejects.toThrow(LAST_ADMIN);
      await expect(
        app.query(`DELETE FROM members WHERE id = $1`, [memberIds[0]]),
      ).rejects.toThrow(LAST_ADMIN);
      expect(await adminCount(orgId)).toBe(1);
    });

    it('rejects creating an active org whose only active member is not an admin', async () => {
      await expect(
        app.transaction(async (em) => {
          const [{ id: orgId }] = await em.query(
            `INSERT INTO organizations (name) VALUES ('org') RETURNING id`,
          );
          const [{ id: memberId }] = await em.query(
            `INSERT INTO members (org_id, status) VALUES ($1, 'active') RETURNING id`,
            [orgId],
          );
          await em.query(
            `INSERT INTO role_bindings (member_id, role_id) VALUES ($1, $2)`,
            [memberId, memberRoleId],
          );
        }),
      ).rejects.toThrow(LAST_ADMIN);
    });

    it('allows removing the last admin of a deleted org', async () => {
      const { orgId, memberIds } = await seedOrg(1);
      await app.query(
        `UPDATE organizations SET status = 'deleted', deleted_at = now() WHERE id = $1`,
        [orgId],
      );

      await expect(
        app.query(`DELETE FROM members WHERE id = $1`, [memberIds[0]]),
      ).resolves.toBeDefined();
    });

    it('rejects creating an active org with no members', async () => {
      await expect(
        app.query(`INSERT INTO organizations (name) VALUES ('empty')`),
      ).rejects.toThrow(LAST_ADMIN);
    });

    it('creates an org with its first admin in one transaction', async () => {
      const orgId = await app.transaction(async (em) => {
        const [{ id }]: Array<{ id: string }> = await em.query(
          `INSERT INTO organizations (name) VALUES ('org') RETURNING id`,
        );
        await addAdmin(em, id);
        return id;
      });

      expect(await adminCount(orgId)).toBe(1);
    });

    it('rejects restoring a deleted org that has no admin left', async () => {
      const { orgId, memberIds } = await seedOrg(1);
      await app.query(
        `UPDATE organizations SET status = 'deleted' WHERE id = $1`,
        [orgId],
      );
      await app.query(`DELETE FROM members WHERE id = $1`, [memberIds[0]]);

      await expect(
        app.query(`UPDATE organizations SET status = 'active' WHERE id = $1`, [
          orgId,
        ]),
      ).rejects.toThrow(LAST_ADMIN);
    });

    it('counts only org-scoped admin bindings', async () => {
      const { memberIds } = await seedOrg(1);

      await expect(
        app.query(
          `UPDATE role_bindings SET scope = 'chain:1' WHERE member_id = $1`,
          [memberIds[0]],
        ),
      ).rejects.toThrow(LAST_ADMIN);
    });

    it('commits two concurrent transactions that each add an admin to the same org', async () => {
      const { orgId } = await seedOrg(1);
      const [a, b] = [app.createQueryRunner(), app.createQueryRunner()];
      try {
        await a.startTransaction();
        await b.startTransaction();
        // both hold FK KEY SHARE locks on the org row before either check runs
        await addAdmin(a, orgId);
        await addAdmin(b, orgId);

        const results = await Promise.allSettled([
          a.commitTransaction(),
          b.commitTransaction(),
        ]);

        expect(results).toEqual([
          { status: 'fulfilled', value: undefined },
          { status: 'fulfilled', value: undefined },
        ]);
        expect(await adminCount(orgId)).toBe(3);
      } finally {
        for (const qr of [a, b]) {
          if (qr.isTransactionActive) await qr.rollbackTransaction();
          await qr.release();
        }
      }
    });

    it('lets exactly one of two concurrent cross-demotions commit', async () => {
      const { orgId, memberIds } = await seedOrg(2);
      const [a, b] = [app.createQueryRunner(), app.createQueryRunner()];
      try {
        await a.startTransaction();
        await b.startTransaction();
        // each admin demotes the other; different rows, so no row-lock wait here
        await a.query(
          `UPDATE role_bindings SET role_id = $1 WHERE member_id = $2`,
          [memberRoleId, memberIds[1]],
        );
        await b.query(
          `UPDATE role_bindings SET role_id = $1 WHERE member_id = $2`,
          [memberRoleId, memberIds[0]],
        );

        // Force the worst interleaving: both checks run while neither has
        // committed. a checks first and keeps the org row lock until commit.
        const immediate = `SET CONSTRAINTS members_keep_one_admin IMMEDIATE`;
        await a.query(immediate);
        const [{ pid }]: Array<{ pid: number }> = await b.query(
          `SELECT pg_backend_pid() AS pid`,
        );
        const bCheck = b.query(immediate).then(() => b.commitTransaction());
        await waitUntilLockWait(pid);
        const results = await Promise.allSettled([
          a.commitTransaction(),
          bCheck,
        ]);

        expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
        expect(String((results[1] as PromiseRejectedResult).reason)).toMatch(
          LAST_ADMIN,
        );
        expect(await adminCount(orgId)).toBe(1);
      } finally {
        for (const qr of [a, b]) {
          if (qr.isTransactionActive) await qr.rollbackTransaction();
          await qr.release();
        }
      }
    });
  });

  describe('contacts row-level security', () => {
    let orgA: string;
    let orgB: string;

    beforeAll(async () => {
      [orgA, orgB] = [(await seedOrg(1)).orgId, (await seedOrg(1)).orgId];
      for (const orgId of [orgA, orgB]) {
        await tx.runInOrgTx(
          (em) =>
            em.query(
              `INSERT INTO contacts (org_id, name, address) VALUES ($1, 'c', '0x0000000000000000000000000000000000000001')`,
              [orgId],
            ),
          orgId,
        );
      }
    });

    it('returns no contact rows of org B when app.org_id is org A', async () => {
      const rows: Array<{ org_id: string }> = await tx.runInOrgTx(
        (em) => em.query(`SELECT org_id FROM contacts`),
        orgA,
      );

      expect(rows).toEqual([{ org_id: orgA }]);
    });

    it('rejects inserting a contact for org B when app.org_id is org A', async () => {
      await expect(
        tx.runInOrgTx(
          (em) =>
            em.query(
              `INSERT INTO contacts (org_id, name, address) VALUES ($1, 'x', '0x0000000000000000000000000000000000000002')`,
              [orgB],
            ),
          orgA,
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it('returns nothing on a connection whose earlier transaction set app.org_id', async () => {
      const qr = app.createQueryRunner();
      try {
        await qr.startTransaction();
        await qr.query(`SELECT set_config('app.org_id', $1, true)`, [orgA]);
        await qr.commitTransaction();

        // the setting is now '' on this connection, not unset
        await expect(qr.query(`SELECT 1 FROM contacts`)).resolves.toEqual([]);
        await expect(
          qr.query(`SELECT 1 FROM contact_requests`),
        ).resolves.toEqual([]);
      } finally {
        await qr.release();
      }
    });
  });

  it('rejects a second wallet identity with the same address in different case', async () => {
    const [{ id: userId }] = await app.query(
      `INSERT INTO users DEFAULT VALUES RETURNING id`,
    );
    const insert = (address: string): Promise<unknown> =>
      app.query(
        `INSERT INTO identities (user_id, kind, wallet_address) VALUES ($1, 'wallet', $2)`,
        [userId, address],
      );

    await insert('0xAbCdEf0000000000000000000000000000000001');
    await expect(
      insert('0xabcdef0000000000000000000000000000000001'),
    ).rejects.toThrow(/duplicate key/);
  });

  it('sessions carry no IP column (item 14: never written)', async () => {
    const columns: Array<{ column_name: string }> = await app.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'sessions'`,
    );
    expect(columns.map((c) => c.column_name)).not.toContain('ip_encrypted');
    expect(columns.map((c) => c.column_name)).toContain('user_agent');
  });

  it('the app login cannot run DDL', async () => {
    await expect(app.query(`CREATE TABLE evil (id int)`)).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      app.query(`ALTER TABLE contacts DISABLE ROW LEVEL SECURITY`),
    ).rejects.toThrow(/must be owner/);
    await expect(app.query(`DROP TABLE contacts`)).rejects.toThrow(
      /must be owner/,
    );
    await expect(app.query(`TRUNCATE contacts`)).rejects.toThrow(
      /permission denied/,
    );
  });
});
