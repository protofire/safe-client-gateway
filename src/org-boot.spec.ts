import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { ContextIdFactory, INQUIRER, REQUEST } from '@nestjs/core';
import { STATIC_CONTEXT } from '@nestjs/core/injector/constants';
import type { NestContainer } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { ORG_REDIS } from '@/modules/org/auth/nonce.store';
import { ORG_DATA_SOURCE } from '@/modules/org/db/org-database.module';
import { OrgAppModule } from '@/org-app.module';

// Keys the sample leaves empty on purpose (secrets); filled with placeholders here
const KEY = Buffer.alloc(32).toString('base64');
const EMPTY_IN_SAMPLE: Record<string, string> = {
  ORG_ENCRYPTION_KEYS: JSON.stringify({ current: 'v1', keys: { v1: KEY } }),
  ORG_EMAIL_HASH_KEY: KEY,
};

/**
 * Boots the full OrgAppModule with only the variables documented in
 * .env.org.sample: a config key a reused gateway provider starts requiring
 * (getOrThrow) that cgw-org does not provide fails here, not in a deploy.
 */
describe('OrgAppModule boot from .env.org.sample', () => {
  const saved = { ...process.env };

  beforeAll(() => {
    const sample = parseEnv(
      readFileSync(join(__dirname, '..', '.env.org.sample'), 'utf8'),
    ) as Record<string, string>;
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ORG_') || key.startsWith('BLOCKLIST_')) {
        delete process.env[key];
      }
    }
    const empty = Object.keys(sample).filter((k) => sample[k] === '');
    expect(empty.sort()).toEqual(Object.keys(EMPTY_IN_SAMPLE).sort());
    Object.assign(process.env, sample, EMPTY_IN_SAMPLE);
  });

  afterAll(() => {
    process.env = saved;
  });

  it('instantiates every provider, controller and injectable', async () => {
    const noop = async (): Promise<void> => {};
    const moduleRef = await Test.createTestingModule({
      imports: [OrgAppModule.register()],
    })
      .overrideProvider('RedisClient')
      .useValue({ ping: noop, isReady: true, quit: noop })
      .overrideProvider(ORG_REDIS)
      .useValue({ quit: noop })
      .overrideProvider(getDataSourceToken(ORG_DATA_SOURCE))
      .useValue({ manager: {}, isInitialized: true, destroy: noop })
      .compile();

    // compile() builds static providers; request/transient ones are resolved here
    const container = (moduleRef as unknown as { container: NestContainer })
      .container;
    const contextId = ContextIdFactory.create();
    let count = 0;
    for (const module of container.getModules().values()) {
      for (const wrapper of [
        ...module.providers.values(),
        ...module.controllers.values(),
        ...module.injectables.values(),
      ]) {
        count++;
        if (wrapper.token === REQUEST || wrapper.token === INQUIRER) continue;
        if (wrapper.isDependencyTreeStatic()) {
          expect({
            name: wrapper.name,
            resolved: wrapper.getInstanceByContextId(STATIC_CONTEXT).isResolved,
          }).toEqual({ name: wrapper.name, resolved: true });
        } else {
          await moduleRef.resolve(wrapper.token, contextId, { strict: false });
        }
      }
    }
    expect(count).toBeGreaterThan(100);
    await moduleRef.close();
  });
});
