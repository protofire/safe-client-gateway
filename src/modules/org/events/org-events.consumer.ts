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

// org pool max is 20 and shared with the API; each in-flight event can hold
// a connection across its node read (per-Safe lock), so 3 at a time (item 9)
export const ORG_EVENTS_PREFETCH = 3;

export type Disposition =
  | { action: 'ack' }
  | { action: 'retry'; attempt: number };

export const ATTEMPTS_HEADER = 'x-org-attempts';
export const MAX_ATTEMPTS = 3;
export const RETRY_DELAY_MS = 2000;

/**
 * Own durable queue on the gateway's fanout exchange (never the gateway's
 * queue). Rulings: a message that cannot be parsed is logged and acked. A
 * handler failure (node, cache, DB) is retried up to MAX_ATTEMPTS deliveries
 * in total: after a delay the message is re-published to this queue with an
 * incremented `x-org-attempts` header, and the original is acked only after
 * the re-publish succeeded (a crash in between redelivers it). After the last
 * attempt it is logged and acked. No dead-letter queue in phase 1.
 */
@Injectable()
export class OrgEventsConsumer implements OnModuleInit, OnApplicationShutdown {
  private connection?: AmqpConnectionManager;
  private channel?: ChannelWrapper;
  private queue = '';
  private readonly timers = new Set<NodeJS.Timeout>();

  constructor(
    @Inject(IConfigurationService)
    private readonly config: IConfigurationService,
    @Inject(LoggingService) private readonly logger: ILoggingService,
    private readonly handler: OrgEventsHandler,
  ) {}

  async onModuleInit(): Promise<void> {
    const url = this.config.getOrThrow<string>('org.amqp.url');
    const exchange = this.config.getOrThrow<string>('org.amqp.exchange');
    this.queue = this.config.getOrThrow<string>('org.amqp.queue');
    const queue = this.queue;
    this.connection = amqp.connect(url, {
      heartbeatIntervalInSeconds: 60,
      reconnectTimeInSeconds: 5,
    });
    this.channel = this.connection.createChannel({
      json: true,
      setup: async (ch: Channel) => {
        await ch.assertExchange(exchange, 'fanout', { durable: true });
        await ch.assertQueue(queue, { durable: true });
        await ch.prefetch(ORG_EVENTS_PREFETCH);
        await ch.bindQueue(queue, exchange, '');
      },
    });
    await this.channel.consume(queue, (msg: ConsumeMessage) => {
      void this.dispatch(msg);
    });
    this.logger.info(`Org events subscribed to queue: ${queue}`);
  }

  private async dispatch(msg: ConsumeMessage): Promise<void> {
    const disposition = await this.processMessage(msg);
    if (disposition.action === 'ack') {
      this.settle(() => this.channel?.ack(msg));
      return;
    }
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      void this.republish(msg, disposition.attempt);
    }, RETRY_DELAY_MS * disposition.attempt);
    this.timers.add(timer);
  }

  private async republish(msg: ConsumeMessage, attempt: number): Promise<void> {
    try {
      await this.channel?.sendToQueue(
        this.queue,
        JSON.parse(msg.content.toString()),
        { persistent: true, headers: { [ATTEMPTS_HEADER]: attempt } },
      );
      this.settle(() => this.channel?.ack(msg));
    } catch (error) {
      this.logger.error(`Org event re-publish failed: ${String(error)}`);
      this.settle(() => this.channel?.nack(msg, false, true));
    }
  }

  /** ack/nack throw on a closed channel; never let that escape. */
  private settle(fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.logger.warn(`Org event settle failed: ${String(error)}`);
    }
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
      return { action: 'ack' };
    }
    try {
      await this.handler.handle(parsed.data);
      return { action: 'ack' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const attempt =
        Number(msg.properties?.headers?.[ATTEMPTS_HEADER] ?? 0) + 1;
      if (attempt < MAX_ATTEMPTS) {
        this.logger.warn(`Org event failed (attempt ${attempt}): ${message}`);
        return { action: 'retry', attempt };
      }
      this.logger.error(
        `Org event dropped after ${attempt} attempts: ${message}`,
      );
      return { action: 'ack' };
    }
  }

  async onApplicationShutdown(): Promise<void> {
    // pending retries stay unacked and are redelivered after the channel closes
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    await this.channel?.close();
    await this.connection?.close();
  }
}
