import { randomBytes } from 'crypto';
import { DataSource } from 'typeorm';
import type { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';
import { orgMigratorDataSource } from '@/org-migrate';

// docker compose service db-test (SSL on); CI provides Postgres without SSL.
// shortcut: db_config/test/server.crt has expired, so the local test server is
// not verified; verify again once that test certificate is regenerated.
const ssl: PostgresConnectionOptions['ssl'] =
  process.env.CI?.toLowerCase() === 'true'
    ? false
    : { rejectUnauthorized: false };
const server = { host: 'localhost', port: 5433, ssl };
const SUPERUSER = { username: 'postgres', password: 'postgres' };
const PASSWORD = 'test-password';

export interface OrgTestDb {
  database: string;
  appUser: string;
  /**
   * Migrator: not a superuser, owns the database (and schema public unless
   * `ownsPublicSchema: false`), as on managed Postgres. Migrations load from
   * TS. Not initialized.
   */
  owner(): DataSource;
  /** Non-superuser, non-owner app login; not initialized. */
  app(): DataSource;
  drop(): Promise<void>;
}

async function asSuperuser(
  database: string,
  sql: Array<string>,
): Promise<void> {
  const ds = new DataSource({
    type: 'postgres',
    ...server,
    ...SUPERUSER,
    database,
  });
  await ds.initialize();
  try {
    for (const statement of sql) await ds.query(statement);
  } finally {
    await ds.destroy();
  }
}

/** Fresh database, migrator role and app login role per call. */
export async function createOrgTestDb(
  options: { ownsPublicSchema?: boolean } = {},
): Promise<OrgTestDb> {
  const suffix = randomBytes(6).toString('hex');
  const database = `org_test_${suffix}`;
  const ownerUser = `org_owner_${suffix}`;
  const appUser = `org_app_${suffix}`;
  const login = `LOGIN PASSWORD '${PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`;
  await asSuperuser('postgres', [
    `CREATE ROLE "${ownerUser}" ${login}`,
    `CREATE ROLE "${appUser}" ${login}`,
    `CREATE DATABASE "${database}" OWNER "${ownerUser}"`,
  ]);
  // PG14 creates schema public owned by the bootstrap superuser
  if (options.ownsPublicSchema ?? true) {
    await asSuperuser(database, [
      `ALTER SCHEMA public OWNER TO "${ownerUser}"`,
    ]);
  }
  return {
    database,
    appUser,
    owner: () =>
      orgMigratorDataSource({
        ...server,
        database,
        username: ownerUser,
        password: PASSWORD,
      }),
    app: () =>
      new DataSource({
        type: 'postgres',
        ...server,
        database,
        username: appUser,
        password: PASSWORD,
      }),
    drop: () =>
      asSuperuser('postgres', [
        `DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`,
        `DROP ROLE IF EXISTS "${appUser}"`,
        `DROP ROLE IF EXISTS "${ownerUser}"`,
      ]),
  };
}
