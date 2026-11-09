import type { ConsumeMessage } from 'amqplib';
import { OrgEventsConsumer } from '@/modules/org/events/org-events.consumer';

const msg = (body: unknown, attempts?: number): ConsumeMessage =>
  ({
    content: Buffer.from(
      typeof body === 'string' ? body : JSON.stringify(body),
    ),
    properties: {
      headers: attempts === undefined ? {} : { 'x-org-attempts': attempts },
    },
  }) as ConsumeMessage;

const valid = {
  type: 'NEW_CONFIRMATION',
  chainId: '1',
  address: '0x0000000000000000000000000000000000000001',
  owner: '0x0000000000000000000000000000000000000002',
  safeTxHash: `0x${'1'.repeat(64)}`,
};

describe('OrgEventsConsumer.processMessage', () => {
  const handler = { handle: jest.fn() };
  const logger = { error: jest.fn(), warn: jest.fn(), info: jest.fn() };
  const consumer = new OrgEventsConsumer(
    {} as never,
    logger as never,
    handler as never,
  );

  beforeEach(() => jest.resetAllMocks());

  it('acks and logs a message that is not valid JSON', async () => {
    expect(await consumer.processMessage(msg('{nope'))).toEqual({
      action: 'ack',
    });
    expect(handler.handle).not.toHaveBeenCalled();
  });

  it('acks a message that fails the event schema', async () => {
    expect(await consumer.processMessage(msg({ type: 'X' }))).toEqual({
      action: 'ack',
    });
    expect(handler.handle).not.toHaveBeenCalled();
  });

  it('acks after a successful handle', async () => {
    handler.handle.mockResolvedValue(undefined);
    expect(await consumer.processMessage(msg(valid))).toEqual({
      action: 'ack',
    });
  });

  it('retries with a counted attempt and drops after the last one', async () => {
    handler.handle.mockRejectedValue(new Error('node down'));
    expect(await consumer.processMessage(msg(valid))).toEqual({
      action: 'retry',
      attempt: 1,
    });
    expect(await consumer.processMessage(msg(valid, 1))).toEqual({
      action: 'retry',
      attempt: 2,
    });
    expect(await consumer.processMessage(msg(valid, 2))).toEqual({
      action: 'ack',
    });
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('does not reject when ack throws on a closed channel', async () => {
    handler.handle.mockResolvedValue(undefined);
    const internals = consumer as unknown as {
      channel: { ack: () => void };
      dispatch: (m: ConsumeMessage) => Promise<void>;
    };
    internals.channel = {
      ack: (): void => {
        throw new Error('Channel closed');
      },
    };
    await expect(internals.dispatch(msg(valid))).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });
});
