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
const APP_PASSWORD = 'test-password';

export interface OrgTestDb {
  database: string;
  appUser: string;
  /** Owner login with the org migrations loaded from TS; not initialized. */
  owner(): DataSource;
  /** Non-superuser, non-owner app login; not initialized. */
  app(): DataSource;
  drop(): Promise<void>;
}

async function asSuperuser(sql: Array<string>): Promise<void> {
  const ds = new DataSource({
    type: 'postgres',
    ...server,
    ...SUPERUSER,
    database: 'postgres',
  });
  await ds.initialize();
  try {
    for (const statement of sql) await ds.query(statement);
  } finally {
    await ds.destroy();
  }
}

/** Fresh database and app login role per test file. */
export async function createOrgTestDb(): Promise<OrgTestDb> {
  const suffix = randomBytes(6).toString('hex');
  const database = `org_test_${suffix}`;
  const appUser = `org_app_${suffix}`;
  await asSuperuser([
    `CREATE DATABASE "${database}"`,
    `CREATE ROLE "${appUser}" LOGIN PASSWORD '${APP_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
  ]);
  return {
    database,
    appUser,
    owner: () => orgMigratorDataSource({ ...server, ...SUPERUSER, database }),
    app: () =>
      new DataSource({
        type: 'postgres',
        ...server,
        database,
        username: appUser,
        password: APP_PASSWORD,
      }),
    drop: () =>
      asSuperuser([
        `DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`,
        `DROP ROLE IF EXISTS "${appUser}"`,
      ]),
  };
}
