import { extname, join } from 'path';
import { DataSource } from 'typeorm';
import type { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';

/**
 * One-off migration entry for the org database (k8s Job / init container).
 * The only code that reads the owner login ORG_DB_MIGRATOR_*; the cgw-org
 * runtime connects with ORG_DB_APP_* and never migrates.
 */

export const ORG_MIGRATIONS_TABLE = '_org_migrations';
const LOCK_KEY = 'cgw-org-migrations';

// .ts under ts-jest/ts-node, .js from dist (the build also emits .d.ts files)
const MIGRATIONS_GLOB = join(
  __dirname,
  '..',
  'migrations',
  'org',
  `*${extname(__filename)}`,
);

type Connection = Pick<
  PostgresConnectionOptions,
  'host' | 'port' | 'database' | 'username' | 'password' | 'ssl'
>;

export function orgMigratorDataSource(connection: Connection): DataSource {
  return new DataSource({
    type: 'postgres',
    ...connection,
    migrations: [MIGRATIONS_GLOB],
    migrationsTableName: ORG_MIGRATIONS_TABLE,
  });
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Runs pending org migrations under a session advisory lock (concurrent
 * runners wait, then find nothing pending), then grants the app login DML on
 * every table except the migrations table. Returns the names applied.
 */
export async function runOrgMigrations(
  dataSource: DataSource,
  appUser: string,
): Promise<Array<string>> {
  const lock = dataSource.createQueryRunner();
  await lock.connect();
  try {
    await lock.query('SELECT pg_advisory_lock(hashtext($1))', [LOCK_KEY]);
    try {
      const applied = await dataSource.runMigrations();
      const app = quoteIdent(appUser);
      await dataSource.transaction(async (em) => {
        await em.query(
          `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${app}`,
        );
        await em.query(
          `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${app}`,
        );
        await em.query(
          `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${app}`,
        );
        await em.query(
          `REVOKE ALL ON ${quoteIdent(ORG_MIGRATIONS_TABLE)} FROM ${app}`,
        );
      });
      return applied.map((m) => m.name);
    } finally {
      await lock.query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK_KEY]);
    }
  } finally {
    await lock.release();
  }
}

const REQUIRED = [
  'ORG_DB_HOST',
  'ORG_DB_NAME',
  'ORG_DB_MIGRATOR_USERNAME',
  'ORG_DB_MIGRATOR_PASSWORD',
  'ORG_DB_APP_USERNAME',
] as const;

export async function main(env = process.env): Promise<number> {
  const missing = REQUIRED.filter((key) => !env[key]);
  if (missing.length > 0) {
    // names only, never values
    console.error(`org-migrate: missing ${missing.join(', ')}`);
    return 1;
  }
  const dataSource = orgMigratorDataSource({
    host: env.ORG_DB_HOST,
    port: env.ORG_DB_PORT ? Number(env.ORG_DB_PORT) : 5432,
    database: env.ORG_DB_NAME,
    username: env.ORG_DB_MIGRATOR_USERNAME,
    password: env.ORG_DB_MIGRATOR_PASSWORD,
    ssl: env.ORG_DB_SSL?.toLowerCase() === 'true',
  });
  try {
    await dataSource.initialize();
    const applied = await runOrgMigrations(
      dataSource,
      env.ORG_DB_APP_USERNAME as string,
    );
    console.info(
      `org-migrate: applied ${applied.length} migration(s)`,
      applied,
    );
    return 0;
  } catch (error) {
    console.error('org-migrate: failed', error);
    return 1;
  } finally {
    if (dataSource.isInitialized) await dataSource.destroy();
  }
}

if (require.main === module) {
  void main().then((code) => process.exit(code));
}
