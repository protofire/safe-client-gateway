import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'net';
import request from 'supertest';
import { McpAppModule } from '@/mcp-app.module';
import configuration from '@/config/entities/__tests__/configuration';
import { BlocklistModule } from '@/config/entities/blocklist.module';
import { TestBlocklistModule } from '@/config/entities/__tests__/test.blocklist.module';
import { CacheModule } from '@/datasources/cache/cache.module';
import { TestCacheModule } from '@/datasources/cache/__tests__/test.cache.module';
import {
  CacheService,
  type ICacheService,
} from '@/datasources/cache/cache.service.interface';
import type { FakeCacheService } from '@/datasources/cache/__tests__/fake.cache.service';
import { PostgresDatabaseService } from '@/datasources/db/v2/postgres-database.service';
import { NetworkModule } from '@/datasources/network/network.module';
import { TestNetworkModule } from '@/datasources/network/__tests__/test.network.module';
import { TxAuthNetworkModule } from '@/datasources/network/tx-auth.network.module';
import { TestTxAuthNetworkModule } from '@/datasources/network/__tests__/test.tx-auth.network.module';
import { QueueReadiness } from '@/domain/interfaces/queue-readiness.interface';
import { TestLoggingModule } from '@/logging/__tests__/test.logging.module';
import { McpLoggingModule } from '@/modules/mcp/logging/mcp-logging.module';
import { CsvExportConsumer } from '@/modules/csv-export/v1/consumers/csv-export.consumer';
import { IHooksRepository } from '@/modules/hooks/domain/hooks.repository.interface';
import { EventCacheHelper } from '@/modules/hooks/domain/helpers/event-cache.helper';
import { SanctionsListService } from '@/modules/relay/domain/sanctions/sanctions-list.service';
import { OutreachFileProcessor } from '@/modules/targeted-messaging/datasources/outreach-file-processor';

describe('McpAppModule', () => {
  let app: INestApplication<Server>;

  beforeEach(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [McpAppModule.register(configuration)],
    })
      .overrideModule(BlocklistModule)
      .useModule(TestBlocklistModule)
      .overrideModule(CacheModule)
      .useModule(TestCacheModule)
      .overrideModule(NetworkModule)
      .useModule(TestNetworkModule)
      .overrideModule(TxAuthNetworkModule)
      .useModule(TestTxAuthNetworkModule)
      .overrideModule(McpLoggingModule)
      .useModule(TestLoggingModule)
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await app.close();
  });

  it('boots without Postgres, AMQP, BullMQ', async () => {
    expect(app.get<ICacheService>(CacheService)).toBeDefined();
    expect(() => app.get(CsvExportConsumer)).toThrow();
    expect(() => app.get(IHooksRepository)).toThrow();
    expect(() => app.get(EventCacheHelper)).toThrow();
    expect(() => app.get(OutreachFileProcessor)).toThrow();
    expect(() => app.get(SanctionsListService)).toThrow();
    expect(() => app.get(PostgresDatabaseService)).toThrow();
    expect(() => app.get('DB_INSTANCE')).toThrow();
    expect(() => app.get(QueueReadiness)).toThrow();

    await request(app.getHttpServer())
      .get('/health/ready')
      .expect(200)
      .expect({ status: 'OK' });
    await request(app.getHttpServer())
      .get('/health/live')
      .expect(200)
      .expect({ status: 'OK' });
  });

  it('is not ready when the cache ping rejects', async () => {
    jest.spyOn(console, 'error').mockImplementation();
    app.get<FakeCacheService>(CacheService).setReadyState(false);

    await request(app.getHttpServer())
      .get('/health/ready')
      .expect(503)
      .expect({ status: 'KO' });
  });

  it('is not ready when the cache ping never settles', async () => {
    jest.spyOn(console, 'error').mockImplementation();
    jest
      .spyOn(app.get<FakeCacheService>(CacheService), 'ping')
      .mockReturnValue(new Promise(() => {}));

    await request(app.getHttpServer())
      .get('/health/ready')
      .expect(503)
      .expect({ status: 'KO' });
  });
});
