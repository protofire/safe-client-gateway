import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import type { DataSource } from 'typeorm';
import orgConfiguration from '@/config/org/org-configuration';
import {
  createOrgTestDb,
  type OrgTestDb,
} from '@/modules/org/db/__tests__/org-test-db';
import { ORG_MIGRATIONS_TABLE, runOrgMigrations } from '@/org-migrate';

function tsFiles(dir: string): Array<string> {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

describe('org migrations entry (org-migrate)', () => {
  let db: OrgTestDb;
  const open: Array<DataSource> = [];

  beforeAll(async () => {
    db = await createOrgTestDb();
  });

  afterAll(async () => {
    await Promise.all(
      open.filter((d) => d.isInitialized).map((d) => d.destroy()),
    );
    await db?.drop();
  });

  it('applies migrations once when two instances run concurrently', async () => {
    const [a, b] = [db.owner(), db.owner()];
    open.push(a, b);
    await Promise.all([a.initialize(), b.initialize()]);

    const [appliedA, appliedB] = await Promise.all([
      runOrgMigrations(a, db.appUser),
      runOrgMigrations(b, db.appUser),
    ]);

    // one instance applies every migration, the other none
    expect([appliedA, appliedB].filter((x) => x.length > 0)).toHaveLength(1);
    const applied = [...appliedA, ...appliedB];
    const rows = await a.query(`SELECT name FROM "${ORG_MIGRATIONS_TABLE}"`);
    expect(rows).toHaveLength(applied.length);
    expect(await runOrgMigrations(a, db.appUser)).toEqual([]);
  });

  it('records migrations in _org_migrations, not _migrations', async () => {
    const ds = db.owner();
    open.push(ds);
    await ds.initialize();

    const rows: Array<{ table_name: string }> = await ds.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name IN ('_org_migrations', '_migrations')`,
    );

    expect(rows.map((r) => r.table_name)).toEqual(['_org_migrations']);
  });

  it('grants the app login DML but not the migrations table', async () => {
    const app = db.app();
    open.push(app);
    await app.initialize();

    await expect(app.query('SELECT count(*) FROM roles')).resolves.toEqual([
      { count: '2' },
    ]);
    await expect(
      app.query(`DELETE FROM "${ORG_MIGRATIONS_TABLE}"`),
    ).rejects.toThrow(/permission denied/);
  });

  it('keeps roles read-only and activity payloads immutable for the app login', async () => {
    const app = db.app();
    open.push(app);
    await app.initialize();
    const [{ id: orgId }] = await app.query(
      `INSERT INTO organizations (name, status) VALUES ('o', 'deleted') RETURNING id`,
    );
    await app.query(
      `INSERT INTO activity_events (org_id, type, ip_encrypted) VALUES ($1, 't', 'x')`,
      [orgId],
    );

    await expect(app.query(`UPDATE roles SET name = 'x'`)).rejects.toThrow(
      /permission denied/,
    );
    await expect(app.query(`DELETE FROM roles`)).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      app.query(`UPDATE activity_events SET payload = '{"forged":true}'`),
    ).rejects.toThrow(/permission denied/);
    await expect(
      app.query(`UPDATE processed_events SET processed_at = now()`),
    ).rejects.toThrow(/permission denied/);
    // personal data may still be cleared
    await expect(
      app.query(
        `UPDATE activity_events SET ip_encrypted = NULL, user_agent = NULL WHERE org_id = $1`,
        [orgId],
      ),
    ).resolves.toBeDefined();
  });

  it('fails before migrating when the migrator does not own schema public', async () => {
    const other = await createOrgTestDb({ ownsPublicSchema: false });
    const ds = other.owner();
    try {
      await ds.initialize();

      await expect(runOrgMigrations(ds, other.appUser)).rejects.toThrow(
        /must own schema public/,
      );
      const [{ n }] = await ds.query(
        `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'`,
      );
      expect(n).toBe(0);
    } finally {
      if (ds.isInitialized) await ds.destroy();
      await other.drop();
    }
  });

  describe('runtime has no migrator credentials', () => {
    afterEach(() => {
      delete process.env.ORG_DB_MIGRATOR_USERNAME;
      delete process.env.ORG_DB_MIGRATOR_PASSWORD;
    });

    it('runtime configuration does not carry ORG_DB_MIGRATOR_*', () => {
      process.env.ORG_DB_MIGRATOR_USERNAME = 'migrator-sentinel';
      process.env.ORG_DB_MIGRATOR_PASSWORD = 'migrator-password-sentinel';

      const config = JSON.stringify(orgConfiguration());

      expect(config).not.toContain('migrator-sentinel');
      expect(config).not.toContain('migrator-password-sentinel');
    });

    it('only the migration entry reads ORG_DB_MIGRATOR_*', () => {
      const root = join(__dirname, '..');
      const readers = tsFiles(join(root, 'src'))
        .filter((f) => !f.endsWith('.spec.ts'))
        .filter((f) => readFileSync(f, 'utf8').includes('ORG_DB_MIGRATOR_'))
        .map((f) => relative(root, f));

      expect(readers).toEqual(['src/org-migrate.ts']);
    });
  });
});
