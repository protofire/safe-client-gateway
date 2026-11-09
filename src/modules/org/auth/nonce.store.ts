import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { createClient } from 'redis';
import { IConfigurationService } from '@/config/configuration.service.interface';
import { LogType } from '@/domain/common/entities/log-type.entity';
import { ILoggingService, LoggingService } from '@/logging/logging.interface';

export const ORG_REDIS = 'OrgRedisClient';
export type OrgRedisClient = ReturnType<typeof createClient>;

const KEY_PREFIX = 'org:auth:nonce:';

/**
 * Org-owned Redis connection (same redis.* config as CacheModule): the
 * gateway CacheService has no SET NX EX or GETDEL on prefixed keys.
 */
export async function orgRedisFactory(
  config: IConfigurationService,
  logging: ILoggingService,
): Promise<OrgRedisClient> {
  const [port, database] = config
    .getOrThrow<string>('redis.port')
    .split('/')
    .map(Number);
  const client = createClient({
    socket: {
      host: config.getOrThrow<string>('redis.host'),
      port,
      keepAliveInitialDelay: config.getOrThrow<number>('redis.keepAlive'),
      connectTimeout: config.getOrThrow<number>('redis.connectTimeout'),
    },
    database,
    username: config.get<string>('redis.user'),
    password: config.get<string>('redis.pass'),
    disableOfflineQueue: config.getOrThrow<boolean>(
      'redis.disableOfflineQueue',
    ),
  });
  // without a listener an 'error' event would crash the process
  client.on('error', (err) =>
    logging.error({
      type: LogType.CacheError,
      source: 'OrgRedis',
      event: err.code ?? err.message,
    }),
  );
  await client.connect();
  return client;
}

export const orgRedisProvider = {
  provide: ORG_REDIS,
  useFactory: orgRedisFactory,
  inject: [IConfigurationService, LoggingService],
};

/** Single-use SIWE nonces. Redis errors propagate to the caller. */
@Injectable()
export class NonceStore implements OnModuleDestroy {
  constructor(@Inject(ORG_REDIS) private readonly redis: OrgRedisClient) {}

  async issue(nonce: string, ttlSeconds: number): Promise<void> {
    await this.redis.set(KEY_PREFIX + nonce, '1', { EX: ttlSeconds, NX: true });
  }

  /** True for exactly one caller per issued nonce. */
  async consume(nonce: string): Promise<boolean> {
    return (await this.redis.getDel(KEY_PREFIX + nonce)) !== null;
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }
}
