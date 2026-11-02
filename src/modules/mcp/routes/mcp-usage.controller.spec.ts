import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'net';
import request from 'supertest';
import { IConfigurationService } from '@/config/configuration.service.interface';
import { McpRateLimitGuard } from '@/modules/mcp/routes/guards/mcp-rate-limit.guard';
import { McpUsageController } from '@/modules/mcp/routes/mcp-usage.controller';
import { McpUsageAuthGuard } from '@/modules/mcp/routes/guards/mcp-usage-auth.guard';
import {
  McpUsageStore,
  type IMcpUsageStore,
  type McpUsageDay,
} from '@/modules/mcp/usage/mcp-usage.store';

const AUTH = 'ops:s3cret';
const basic = (credentials: string): string =>
  `Basic ${Buffer.from(credentials).toString('base64')}`;
const today = (): string => new Date().toISOString().slice(0, 10);

describe('McpUsageController', () => {
  let app: INestApplication<Server>;
  const getDay = jest.fn<ReturnType<IMcpUsageStore['getDay']>, [string]>();

  async function start(usageAuth: string | undefined): Promise<void> {
    const moduleFixture = await Test.createTestingModule({
      controllers: [McpUsageController],
      providers: [
        McpUsageAuthGuard,
        { provide: McpUsageStore, useValue: { getDay } },
        {
          provide: IConfigurationService,
          useValue: { get: (): string | undefined => usageAuth },
        },
      ],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
  }

  beforeEach(() => {
    jest.resetAllMocks();
    getDay.mockResolvedValue({ calls: {}, clients: 0 });
  });

  afterEach(async () => {
    await app.close();
  });

  describe('auth', () => {
    it('401 without auth', async () => {
      await start(AUTH);
      await request(app.getHttpServer()).get('/mcp/usage.json').expect(401);
      expect(getDay).not.toHaveBeenCalled();
    });

    it('401 with a wrong password', async () => {
      await start(AUTH);
      await request(app.getHttpServer())
        .get('/mcp/usage.json')
        .set('Authorization', basic('ops:wrong'))
        .expect(401);
    });

    it('401 for every request when MCP_USAGE_AUTH is unset', async () => {
      await start(undefined);
      await request(app.getHttpServer())
        .get('/mcp/usage.json')
        .set('Authorization', basic(':'))
        .expect(401);
      await request(app.getHttpServer())
        .get('/mcp/usage.json')
        .set('Authorization', basic('undefined:undefined'))
        .expect(401);
    });
  });

  it('returns 30 days, newest first', async () => {
    await start(AUTH);
    getDay.mockImplementation((date) =>
      Promise.resolve<McpUsageDay>(
        date === today()
          ? {
              calls: { 'get_safe|1|claude-code|ok': 3 },
              clients: 2,
            }
          : { calls: {}, clients: 0 },
      ),
    );

    const { body } = await request(app.getHttpServer())
      .get('/mcp/usage.json')
      .set('Authorization', basic(AUTH))
      .expect(200);

    expect(body.windowDays).toBe(30);
    expect(body.days).toHaveLength(30);
    expect(body.days[0]).toEqual({
      date: today(),
      calls: [
        {
          tool: 'get_safe',
          chainId: '1',
          client: 'claude-code',
          outcome: 'ok',
          count: 3,
        },
      ],
      distinctClients: 2,
    });
    const dates = (body.days as Array<{ date: string }>).map((d) => d.date);
    expect(dates).toEqual([...dates].sort().reverse());
    expect(body.coverage).toEqual({ daysRead: 30, daysFailed: 0 });
    expect(body.freshness).toEqual({ lastCallDate: today() });
  });

  it('a failed day counts in coverage.daysFailed and is omitted, status 200', async () => {
    await start(AUTH);
    getDay.mockImplementation((date) =>
      date === today()
        ? Promise.reject(new Error('redis down'))
        : Promise.resolve({ calls: {}, clients: 0 }),
    );

    const { body } = await request(app.getHttpServer())
      .get('/mcp/usage.json')
      .set('Authorization', basic(AUTH))
      .expect(200);

    expect(body.coverage).toEqual({ daysRead: 29, daysFailed: 1 });
    expect(body.days).toHaveLength(29);
    expect(body.freshness).toEqual({ lastCallDate: null });
  });

  it('a hung read times out into daysFailed instead of hanging', async () => {
    await start(AUTH);
    getDay.mockReturnValue(new Promise(() => {}));

    // Real 2 s timeout
    const { status, body } = await request(app.getHttpServer())
      .get('/mcp/usage.json')
      .set('Authorization', basic(AUTH));

    expect(status).toBe(200);
    expect(body.coverage).toEqual({ daysRead: 0, daysFailed: 30 });
  });

  it('the route skips McpRateLimitGuard', () => {
    const guards = [
      ...((Reflect.getMetadata('__guards__', McpUsageController) as
        | Array<unknown>
        | undefined) ?? []),
      ...((Reflect.getMetadata(
        '__guards__',
        McpUsageController.prototype.report,
      ) as Array<unknown> | undefined) ?? []),
    ];
    expect(guards).toEqual([McpUsageAuthGuard]);
    expect(guards).not.toContain(McpRateLimitGuard);
  });
});
