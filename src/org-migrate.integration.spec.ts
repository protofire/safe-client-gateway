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

    expect([...appliedA, ...appliedB]).toHaveLength(1);
    const rows = await a.query(`SELECT name FROM "${ORG_MIGRATIONS_TABLE}"`);
    expect(rows).toHaveLength(1);
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
