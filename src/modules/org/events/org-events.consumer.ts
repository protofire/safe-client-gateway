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
import type { Event } from '@/modules/hooks/routes/entities/event.entity';
import { EventSchema } from '@/modules/hooks/routes/entities/schemas/event.schema';
import { OrgEventsHandler } from '@/modules/org/events/org-events.handler';

// org pool max is 20 and shared with the API; each in-flight event can hold
// a connection across its node read (per-Safe lock), so 3 at a time (item 9)
export const ORG_EVENTS_CONCURRENCY = 3;
// events of known Safes waiting for a free slot; beyond it they are dropped
export const ORG_EVENTS_BUFFER = 1000;

/**
 * Own durable queue on the gateway's fanout exchange (never the gateway's
 * queue), which carries every event of the environment.
 *
 * Events are hints, not the source of truth: each thing they trigger also
 * has a periodic pass (cache TTL, reconcile, policy scan, payout status).
 * So the queue is read without acknowledgements and nothing is retried: an
 * event of a Safe the org layer does not know is dropped before any I/O, a
 * failed one is logged, and events beyond the buffer are dropped.
 */
@Injectable()
export class OrgEventsConsumer implements OnModuleInit, OnApplicationShutdown {
  private connection?: AmqpConnectionManager;
  private channel?: ChannelWrapper;
  private readonly buffer: Array<Event> = [];
  private inFlight = 0;
  private dropped = 0;

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
        await ch.bindQueue(queue, exchange, '');
      },
    });
    // the wrapper emits 'error' when a setup call or consumer re-registration
    // fails; without a listener that emit throws and terminates the process
    this.channel.on('error', (error: Error) => {
      this.logger.error(`Org events channel error: ${error.message}`);
    });
    // loaded before the first message: with noAck the broker hands over the
    // whole backlog at once, and every message would wait on this query
    await this.handler.knows('', '');
    await this.channel.consume(
      queue,
      (msg: ConsumeMessage) => {
        void this.receive(msg);
      },
      { noAck: true },
    );
    this.logger.info(`Org events subscribed to queue: ${queue}`);
  }

  /** Never rejects: it is called without an await from the consume callback. */
  async receive(msg: ConsumeMessage): Promise<void> {
    try {
      const raw: unknown = JSON.parse(msg.content.toString());
      const { chainId, address } = (raw ?? {}) as Record<string, unknown>;
      // events without a Safe (chain updates, delegates) do nothing here
      if (typeof chainId !== 'string' || typeof address !== 'string') return;
      if (!(await this.handler.knows(chainId, address))) return;
      const parsed = EventSchema.safeParse(raw);
      if (!parsed.success) {
        this.logger.warn({ type: 'org_events_unparseable' });
        return;
      }
      if (this.buffer.length >= ORG_EVENTS_BUFFER) {
        // logged once per overflow, with the total when it ends
        if (this.dropped++ === 0) {
          this.logger.warn({ type: 'org_events_buffer_full' });
        }
        return;
      }
      this.buffer.push(parsed.data);
      this.pump();
    } catch (error) {
      this.logger.warn(
        `Org event skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private pump(): void {
    while (this.inFlight < ORG_EVENTS_CONCURRENCY && this.buffer.length > 0) {
      const event = this.buffer.shift() as Event;
      this.inFlight++;
      void this.handler
        .handle(event)
        .catch((error: unknown) =>
          // not retried, so this is the event's final outcome
          this.logger.error(
            `Org event failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        )
        .finally(() => {
          this.inFlight--;
          if (this.dropped > 0 && this.buffer.length === 0) {
            this.logger.warn({
              type: 'org_events_dropped',
              count: this.dropped,
            });
            this.dropped = 0;
          }
          this.pump();
        });
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.buffer.length = 0;
    await this.channel?.close();
    await this.connection?.close();
  }
}
