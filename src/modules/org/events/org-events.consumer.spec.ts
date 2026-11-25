import { ORG_PG_POOL } from '@/modules/org/db/org-database.module';
import {
  ORG_EVENTS_BUFFER,
  ORG_EVENTS_CONCURRENCY,
  OrgEventsConsumer,
} from '@/modules/org/events/org-events.consumer';
import { RECONCILE_CONCURRENCY } from '@/modules/org/events/org-events.reconciler';
import type { ConsumeMessage } from 'amqplib';

const msg = (body: unknown): ConsumeMessage =>
  ({
    content: Buffer.from(
      typeof body === 'string' ? body : JSON.stringify(body),
    ),
  }) as ConsumeMessage;

const valid = {
  type: 'NEW_CONFIRMATION',
  chainId: '1',
  address: '0x0000000000000000000000000000000000000001',
  owner: '0x0000000000000000000000000000000000000002',
  safeTxHash: `0x${'1'.repeat(64)}`,
};

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('OrgEventsConsumer.receive', () => {
  const handler = { handle: jest.fn(), knows: jest.fn() };
  const logger = { error: jest.fn(), warn: jest.fn(), info: jest.fn() };
  let consumer: OrgEventsConsumer;

  beforeEach(() => {
    jest.resetAllMocks();
    handler.knows.mockReturnValue(true);
    handler.handle.mockResolvedValue(undefined);
    consumer = new OrgEventsConsumer(
      {} as never,
      logger as never,
      handler as never,
    );
  });

  it('skips a message that is not valid JSON', () => {
    expect(() => consumer.receive(msg('{nope'))).not.toThrow();
    expect(handler.knows).not.toHaveBeenCalled();
    expect(handler.handle).not.toHaveBeenCalled();
  });

  it('skips an event without a Safe before any lookup', () => {
    consumer.receive(msg({ type: 'CHAIN_UPDATE', chainId: '1' }));
    consumer.receive(msg(null));
    expect(handler.knows).not.toHaveBeenCalled();
    expect(handler.handle).not.toHaveBeenCalled();
  });

  it('drops an event of a Safe the org layer does not know', () => {
    handler.knows.mockReturnValue(false);
    consumer.receive(msg(valid));
    expect(handler.knows).toHaveBeenCalledWith(valid.chainId, valid.address);
    expect(handler.handle).not.toHaveBeenCalled();
  });

  it('skips a known Safe event that fails the event schema', () => {
    consumer.receive(msg({ ...valid, type: 'X' }));
    expect(handler.handle).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith({
      type: 'org_events_unparseable',
    });
  });

  it('handles a known Safe event once', () => {
    consumer.receive(msg(valid));
    expect(handler.handle).toHaveBeenCalledTimes(1);
  });

  it('logs a failed event and does not retry it', async () => {
    handler.handle.mockRejectedValue(new Error('node down'));
    consumer.receive(msg(valid));
    await tick();
    expect(handler.handle).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith('Org event failed: node down');
  });

  it('runs at most ORG_EVENTS_CONCURRENCY at a time, then the rest in order', async () => {
    const release: Array<() => void> = [];
    handler.handle.mockImplementation(
      () => new Promise<void>((r) => release.push(r)),
    );
    const hash = (i: number): string => `0x${String(i).padStart(64, '0')}`;
    for (let i = 0; i < ORG_EVENTS_CONCURRENCY + 2; i++) {
      consumer.receive(msg({ ...valid, safeTxHash: hash(i) }));
    }
    expect(handler.handle).toHaveBeenCalledTimes(ORG_EVENTS_CONCURRENCY);
    release[0]();
    await tick();
    expect(handler.handle).toHaveBeenCalledTimes(ORG_EVENTS_CONCURRENCY + 1);
    expect(handler.handle).toHaveBeenLastCalledWith(
      expect.objectContaining({ safeTxHash: hash(ORG_EVENTS_CONCURRENCY) }),
    );
    release[1]();
    await tick();
    expect(handler.handle).toHaveBeenLastCalledWith(
      expect.objectContaining({ safeTxHash: hash(ORG_EVENTS_CONCURRENCY + 1) }),
    );
  });

  it('drops events beyond the buffer and reports the count once there is room again', async () => {
    const release: Array<() => void> = [];
    handler.handle.mockImplementation(
      () => new Promise<void>((r) => release.push(r)),
    );
    const total = ORG_EVENTS_CONCURRENCY + ORG_EVENTS_BUFFER + 2;
    for (let i = 0; i < total; i++) consumer.receive(msg(valid));
    expect(logger.warn).toHaveBeenCalledWith({
      type: 'org_events_buffer_full',
    });
    while (release.length > 0) {
      release.shift()!();
      await tick();
    }
    expect(handler.handle).toHaveBeenCalledTimes(total - 2);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    consumer.receive(msg(valid));
    expect(logger.warn).toHaveBeenCalledWith({
      type: 'org_events_dropped',
      count: 2,
    });
  });
});

describe('org pool budget (item 9)', () => {
  it('keeps event handling and reconcile within a quarter of the shared org pool', () => {
    // each in-flight event or reconciled Safe can hold one connection
    // (per-Safe lock held across the node read); the API shares the pool
    expect(ORG_EVENTS_CONCURRENCY + RECONCILE_CONCURRENCY).toBeLessThanOrEqual(
      ORG_PG_POOL.max / 4,
    );
  });
});
