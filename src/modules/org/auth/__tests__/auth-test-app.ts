import { Global, Module, type DynamicModule, type Type } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { getDataSourceToken, TypeOrmModule } from '@nestjs/typeorm';
import { randomBytes } from 'node:crypto';
import { createClient } from 'redis';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import type { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';
import { IConfigurationService } from '@/config/configuration.service.interface';
import { CacheModule } from '@/datasources/cache/cache.module';
import { LoggingService } from '@/logging/logging.interface';
import { OrgAuthModule } from '@/modules/org/auth/org-auth.module';
import { Clock } from '@/modules/org/common/clock';
import { sha256Hex } from '@/modules/org/crypto/hashing';
import {
  createOrgTestDb,
  type OrgTestDb,
} from '@/modules/org/db/__tests__/org-test-db';
import { ORG_DATA_SOURCE } from '@/modules/org/db/org-data-source';
import { PermissionsModule } from '@/modules/org/permissions/permissions.module';
import { configureOrgApp } from '@/org-main';
import { ORG_APP_GUARDS } from '@/org-app.module';
import { runOrgMigrations } from '@/org-migrate';
import { GlobalErrorFilter } from '@/routes/common/filters/global-error.filter';
import { ZodErrorFilter } from '@/routes/common/filters/zod-error.filter';

export const APP_URL = 'https://app.example.com';
export const MINUTE = 60_000;

export type AuthTestApp = {
  app: NestExpressApplication;
  sql: DataSource;
  redis: ReturnType<typeof createClient>;
  /** Shifts the injected Clock; reset in `reset()`. */
  setOffset(ms: number): void;
  http(): ReturnType<typeof request>;
  /** POST with the CSRF header and a fresh client IP. */
  post(path: string): request.Test;
  del(path: string): request.Test;
  reset(): Promise<void>;
  close(): Promise<void>;
};

let ipSeq = 0;
const nextIp = (): string => `10.2.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;

/** OrgAuthModule (+ given feature modules) on a fresh org DB, with a test Clock. */
export async function createAuthTestApp(args: {
  redisDb: number;
  config?: Record<string, unknown>;
  imports?: Array<Type | DynamicModule>;
}): Promise<AuthTestApp> {
  const config: Record<string, unknown> = {
    'org.trustProxyHops': 1,
    'org.publicAppUrl': APP_URL,
    'express.jsonLimit': '1mb',
    'org.session.idleTtlSeconds': 12 * 3600,
    'org.session.absoluteTtlSeconds': 7 * 24 * 3600,
    'org.session.strongAuthWindowSeconds': 30 * 60,
    'org.encryption.keys': JSON.stringify({
      current: 'v1',
      keys: { v1: randomBytes(32).toString('base64') },
    }),
    'org.emailHashKey': randomBytes(32).toString('base64'),
    'auth.nonceTtlSeconds': 300,
    'redis.host': '127.0.0.1',
    'redis.port': `6379/${args.redisDb}`,
    'redis.connectTimeout': 10_000,
    'redis.keepAlive': 30_000,
    'redis.disableOfflineQueue': false,
    'expirationTimeInSeconds.default': 60,
    'expirationTimeInSeconds.deviatePercent': 0,
    ...args.config,
  };

  @Global()
  @Module({
    providers: [
      {
        provide: IConfigurationService,
        useValue: {
          getOrThrow: (k: string): unknown => {
            if (config[k] === undefined) throw new Error(`missing ${k}`);
            return config[k];
          },
          get: (k: string): unknown => config[k],
        },
      },
      {
        provide: LoggingService,
        useValue: {
          error: jest.fn(),
          warn: jest.fn(),
          info: jest.fn(),
          debug: jest.fn(),
        },
      },
    ],
    exports: [IConfigurationService, LoggingService],
  })
  class TestProvidersModule {}

  const db: OrgTestDb = await createOrgTestDb();
  const owner = db.owner();
  await owner.initialize();
  await runOrgMigrations(owner, db.appUser);
  await owner.destroy();

  const redis = createClient({ url: `redis://127.0.0.1:6379/${args.redisDb}` });
  await redis.connect();
  await redis.flushDb();

  let offsetMs = 0;
  const clock = { now: (): Date => new Date(Date.now() + offsetMs) };

  const moduleRef = await Test.createTestingModule({
    imports: [
      TestProvidersModule,
      CacheModule.register('org:'),
      TypeOrmModule.forRoot({
        ...(db.app().options as PostgresConnectionOptions),
        name: ORG_DATA_SOURCE,
      }),
      OrgAuthModule,
      ...(args.imports ?? []),
      PermissionsModule,
    ],
    providers: [
      { provide: APP_FILTER, useClass: GlobalErrorFilter },
      { provide: APP_FILTER, useClass: ZodErrorFilter },
      ...ORG_APP_GUARDS,
    ],
  })
    .overrideProvider(Clock)
    .useValue(clock)
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  configureOrgApp(app);
  await app.init();
  const sql = moduleRef.get<DataSource>(getDataSourceToken(ORG_DATA_SOURCE), {
    strict: false,
  });

  const http = (): ReturnType<typeof request> => request(app.getHttpServer());
  return {
    app,
    sql,
    redis,
    setOffset: (ms): void => {
      offsetMs = ms;
    },
    http,
    post: (path): request.Test =>
      http()
        .post(path)
        .set('X-Org-Request', '1')
        .set('X-Forwarded-For', nextIp()),
    del: (path): request.Test =>
      http()
        .delete(path)
        .set('X-Org-Request', '1')
        .set('X-Forwarded-For', nextIp()),
    reset: async (): Promise<void> => {
      offsetMs = 0;
      await redis.flushDb();
    },
    close: async (): Promise<void> => {
      await app.close();
      await redis.flushDb();
      await redis.quit();
      await db.drop();
    },
  };
}

/** `name=value` of a Set-Cookie header, for the Cookie request header. */
export function cookieFrom(res: request.Response, name: string): string {
  const raw = [res.headers['set-cookie']].flat().join('\n');
  const match = new RegExp(`(?:^|\\n)${name}=([^;]*)`).exec(raw);
  if (!match || match[1] === '') throw new Error(`no ${name} cookie`);
  return `${name}=${match[1]}`;
}

/**
 * Inserts a user with a session. `wallet` adds a wallet identity; the session
 * is strong at `strongAt` (null = never).
 */
export async function seedUser(
  sql: DataSource,
  opts: { wallet?: boolean; strongAt?: Date | null } = {},
): Promise<{ userId: string; cookie: string }> {
  const token = randomBytes(32).toString('base64url');
  const userId = await sql.transaction(async (em) => {
    const [{ id }] = await em.query(
      `INSERT INTO users DEFAULT VALUES RETURNING id`,
    );
    if (opts.wallet) {
      await em.query(
        `INSERT INTO identities (user_id, kind, wallet_address) VALUES ($1, 'wallet', $2)`,
        [id, `0x${randomBytes(20).toString('hex')}`],
      );
    }
    await em.query(
      `INSERT INTO sessions (user_id, token_hash, amr, last_strong_auth_at, expires_at, idle_expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '1 day', now() + interval '1 day')`,
      [
        id,
        sha256Hex(token),
        opts.wallet ? '{siwe}' : '{oidc}',
        opts.strongAt ?? null,
      ],
    );
    return id as string;
  });
  return { userId, cookie: `org_session=${token}` };
}
