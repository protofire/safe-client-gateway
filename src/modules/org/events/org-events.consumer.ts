import {
  Inject,
  Injectable,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import amqp, {
  type AmqpConnectionManager,
  type ChannelWrapper,
} from 'amqp-connection-manager';
import type { Channel, ConsumeMessage } from 'amqplib';
import { IConfigurationService } from '@/config/configuration.service.interface';
import { ILoggingService, LoggingService } from '@/logging/logging.interface';
import { EventSchema } from '@/modules/hooks/routes/entities/schemas/event.schema';
import { OrgEventsHandler } from '@/modules/org/events/org-events.handler';

export type Disposition = 'ack' | 'requeue';

/**
 * Own durable queue on the gateway's fanout exchange (never the gateway's
 * queue). Rulings: a message that cannot be parsed is logged and acked; a
 * handler failure (node, cache, DB) is requeued once, then logged and acked.
 * No dead-letter queue in phase 1.
 */
@Injectable()
export class OrgEventsConsumer implements OnModuleInit, OnApplicationShutdown {
  private connection?: AmqpConnectionManager;
  private channel?: ChannelWrapper;

  constructor(
    @Inject(IConfigurationService)
    private readonly config: IConfigurationService,
    @Inject(LoggingService) private readonly logger: ILoggingService,
    private readonly handler: OrgEventsHandler,
  ) {}

  async onModuleInit(): Promise<void> {
    const url = this.config.getOrThrow<string>('org.amqp.url');
    const exchange = this.config.getOrThrow<string>('org.amqp.exchange');
    const queue = this.config.getOrThrow<string>('org.amqp.queue');
    this.connection = amqp.connect(url, {
      heartbeatIntervalInSeconds: 60,
      reconnectTimeInSeconds: 5,
    });
    this.channel = this.connection.createChannel({
      json: true,
      setup: async (ch: Channel) => {
        await ch.assertExchange(exchange, 'fanout', { durable: true });
        await ch.assertQueue(queue, { durable: true });
        await ch.prefetch(10);
        await ch.bindQueue(queue, exchange, '');
      },
    });
    await this.channel.consume(queue, (msg: ConsumeMessage) => {
      void this.processMessage(msg).then((d) =>
        d === 'ack'
          ? this.channel?.ack(msg)
          : this.channel?.nack(msg, false, true),
      );
    });
    this.logger.info(`Org events subscribed to queue: ${queue}`);
  }

  async processMessage(msg: ConsumeMessage): Promise<Disposition> {
    let parsed;
    try {
      parsed = EventSchema.safeParse(JSON.parse(msg.content.toString()));
    } catch {
      parsed = null;
    }
    if (!parsed?.success) {
      this.logger.warn({ type: 'org_events_unparseable' });
      return 'ack';
    }
    try {
      await this.handler.handle(parsed.data);
      return 'ack';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!msg.fields.redelivered) {
        this.logger.warn(`Org event failed, requeueing once: ${message}`);
        return 'requeue';
      }
      this.logger.error(`Org event dropped after retry: ${message}`);
      return 'ack';
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.channel?.close();
    await this.connection?.close();
  }
}
