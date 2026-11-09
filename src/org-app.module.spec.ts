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

const SENTINEL = 'gateway-secret-sentinel';

describe('OrgAppModule', () => {
  it('resolves the cache key prefix "org:"', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [OrgAppModule.register()],
    })
      .overrideProvider('RedisClient')
      .useValue({ ping: jest.fn(), isReady: true, quit: jest.fn() })
      .compile();

    expect(moduleRef.get(CacheKeyPrefix, { strict: false })).toBe('org:');
    await moduleRef.close();
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
      .compile();

    expect(process.env.JWT_SECRET).toBeUndefined();
    await moduleRef.close();
  });
});
