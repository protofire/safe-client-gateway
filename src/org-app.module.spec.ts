import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Test } from '@nestjs/testing';
import { IConfigurationService } from '@/config/configuration.service.interface';
import { CacheKeyPrefix } from '@/datasources/cache/constants';
import { OrgAppModule } from '@/org-app.module';
import orgConfiguration from '@/config/org/org-configuration';
import { ConfigurationModule } from '@/config/configuration.module';
import { OrgConfigurationSchema } from '@/config/org/org-configuration.schema';
import { Module } from '@nestjs/common';
import { getDataSourceToken } from '@nestjs/typeorm';
import { ORG_DATA_SOURCE } from '@/modules/org/db/org-database.module';
import { OrgTransaction } from '@/modules/org/db/org-transaction';

// No database in unit tests: the 'org' DataSource is replaced, never connected.
// The connection options factory still runs, so its keys must be present.
const fakeOrgDataSource = {
  manager: {},
  isInitialized: true,
  destroy: jest.fn(),
};
Object.assign(process.env, {
  ORG_DB_HOST: 'localhost',
  ORG_DB_NAME: 'org',
  ORG_DB_APP_USERNAME: 'org_app',
  ORG_DB_APP_PASSWORD: 'test-password',
  ORG_PUBLIC_APP_URL: 'https://app.example.com',
});

const SENTINEL = 'gateway-secret-sentinel';

describe('OrgAppModule', () => {
  it('resolves the cache key prefix "org:"', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [OrgAppModule.register()],
    })
      .overrideProvider('RedisClient')
      .useValue({ ping: jest.fn(), isReady: true, quit: jest.fn() })
      .overrideProvider(getDataSourceToken(ORG_DATA_SOURCE))
      .useValue(fakeOrgDataSource)
      .compile();

    expect(moduleRef.get(CacheKeyPrefix, { strict: false })).toBe('org:');
    await moduleRef.close();
  });

  it('compiles with OrgDatabaseModule and provides OrgTransaction', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [OrgAppModule.register()],
    })
      .overrideProvider('RedisClient')
      .useValue({ ping: jest.fn(), isReady: true, quit: jest.fn() })
      .overrideProvider(getDataSourceToken(ORG_DATA_SOURCE))
      .useValue(fakeOrgDataSource)
      .compile();

    expect(moduleRef.get(OrgTransaction, { strict: false })).toBeInstanceOf(
      OrgTransaction,
    );
    fakeOrgDataSource.destroy.mockClear();
    await moduleRef.close();
    expect(fakeOrgDataSource.destroy).toHaveBeenCalledTimes(1);
  });
});

describe('env file isolation', () => {
  const cwd = process.cwd();
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'org-env-'));
    writeFileSync(join(dir, '.env'), `JWT_SECRET=${SENTINEL}\n`);
    process.chdir(dir);
    delete process.env.JWT_SECRET;
  });

  afterEach(() => {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
    delete process.env.JWT_SECRET;
  });

  async function boot(ignoreEnvFile: boolean): Promise<IConfigurationService> {
    @Module({
      imports: [
        ConfigurationModule.register(
          () => ({ jwt: { secret: process.env.JWT_SECRET } }),
          OrgConfigurationSchema,
          { ignoreEnvFile },
        ),
      ],
    })
    class M {}
    const ref = await Test.createTestingModule({ imports: [M] }).compile();
    return ref.get<IConfigurationService>(IConfigurationService, {
      strict: false,
    });
  }

  it('control: the default registration does load ./.env', async () => {
    const config = await boot(false);

    expect(process.env.JWT_SECRET).toBe(SENTINEL);
    expect(config.get('jwt.secret')).toBe(SENTINEL);
  });

  it('org registration does not load a .env next to the process', async () => {
    const config = await boot(true);

    expect(process.env.JWT_SECRET).toBeUndefined();
    expect(config.get('jwt.secret')).toBeUndefined();
  });

  it('OrgAppModule registers with ignoreEnvFile', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [OrgAppModule.register(orgConfiguration)],
    })
      .overrideProvider('RedisClient')
      .useValue({ ping: jest.fn(), isReady: true, quit: jest.fn() })
      .overrideProvider(getDataSourceToken(ORG_DATA_SOURCE))
      .useValue(fakeOrgDataSource)
      .compile();

    expect(process.env.JWT_SECRET).toBeUndefined();
    await moduleRef.close();
  });
});
