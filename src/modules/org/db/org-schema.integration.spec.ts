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
      const [{ id: orgId }] = await em.query(
        `INSERT INTO organizations (name) VALUES ('org') RETURNING id`,
      );
      const memberIds: Array<string> = [];
      for (let i = 0; i < admins; i++) {
        const [{ id: userId }] = await em.query(
          `INSERT INTO users DEFAULT VALUES RETURNING id`,
        );
        const [{ id: memberId }]: Array<{ id: string }> = await em.query(
          `INSERT INTO members (org_id, user_id, status) VALUES ($1, $2, 'active') RETURNING id`,
          [orgId, userId],
        );
        await em.query(
          `INSERT INTO role_bindings (member_id, role_id) VALUES ($1, $2)`,
          [memberId, adminRoleId],
        );
        memberIds.push(memberId);
      }
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

  /** Resolves once backend `pid` waits on a lock; gives up after 2 s. */
  async function waitUntilLockWait(pid: number): Promise<void> {
    for (let i = 0; i < 40; i++) {
      const [row] = await owner.query(
        `SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1`,
        [pid],
      );
      if (row?.wait_event_type === 'Lock') return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
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

    it('returns nothing without app.org_id, also on a connection that had one', async () => {
      await expect(
        tx.runInOrgTx((em) => em.query(`SELECT 1 FROM contacts`)),
      ).resolves.toEqual([]);
      await expect(
        app.query(`SELECT 1 FROM contact_requests`),
      ).resolves.toEqual([]);
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
