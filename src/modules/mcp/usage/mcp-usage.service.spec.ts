import { createHash } from 'crypto';
import type { ClsService } from 'nestjs-cls';
import { LogType } from '@/domain/common/entities/log-type.entity';
import type { ILoggingService } from '@/logging/logging.interface';
import { MCP_IP_KEY } from '@/modules/mcp/routes/guards/mcp-rate-limit.guard';
import {
  McpToolEvents,
  type McpToolCall,
} from '@/modules/mcp/tools/define-tool';
import {
  McpUsageService,
  MCP_USER_AGENT_KEY,
} from '@/modules/mcp/usage/mcp-usage.service';
import { FakeMcpUsageStore } from '@/modules/mcp/usage/__tests__/fake-mcp-usage.store';
import type { IMcpUsageStore } from '@/modules/mcp/usage/mcp-usage.store';

const IP = '203.0.113.7';
const USER_AGENT = 'claude-code/2.1';

describe('McpUsageService', () => {
  const logging = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as jest.MockedObjectDeep<ILoggingService>;
  const cls = {
    get: jest.fn(
      (key: string) =>
        ({ [MCP_IP_KEY]: IP, [MCP_USER_AGENT_KEY]: USER_AGENT })[key],
    ),
  } as unknown as ClsService;
  let events: McpToolEvents;

  function build(store: IMcpUsageStore): void {
    events = new McpToolEvents(logging);
    new McpUsageService(events, store, logging, cls);
  }

  const call = (overrides: Partial<McpToolCall> = {}): McpToolCall => ({
    tool: 'get_safe',
    chainId: '1',
    outcome: 'ok',
    latencyMs: 12.4,
    resultCount: 1,
    useful: true,
    clientName: 'claude-code',
    protocolVersion: '2026-07-28',
    ...overrides,
  });

  /** Lets fire-and-forget writes settle. */
  const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('counts a call under tool|chain|label|outcome', async () => {
    const store = new FakeMcpUsageStore();
    build(store);

    events.onCall(call());
    events.onCall(call());
    await settle();

    expect(store.calls).toEqual({ 'get_safe|1|claude-code|ok': 2 });
  });

  it('adds a client only for useful tools', async () => {
    const store = new FakeMcpUsageStore();
    build(store);

    events.onCall(call({ tool: 'list_chains', chainId: null, useful: false }));
    await settle();
    expect(store.clients.size).toBe(0);

    events.onCall(call());
    await settle();
    expect(store.clients.size).toBe(1);
  });

  it('hash is sha256(ip|user-agent|salt), the raw ip reaches neither store nor log', async () => {
    const store = new FakeMcpUsageStore();
    const spies = [
      jest.spyOn(store, 'incrementCall'),
      jest.spyOn(store, 'addClient'),
      jest.spyOn(store, 'getDailySalt'),
    ];
    build(store);

    events.onCall(call());
    await settle();

    const expected = createHash('sha256')
      .update(`${IP}|${USER_AGENT}|${store.salt}`)
      .digest('hex');
    expect([...store.clients]).toEqual([expected]);
    const everything = JSON.stringify([
      ...spies.flatMap((spy) => spy.mock.calls as Array<unknown>),
      ...Object.values(logging).flatMap((fn) => fn.mock.calls),
    ]);
    expect(everything).not.toContain(IP);
    expect(everything).not.toContain(USER_AGENT);
  });

  it('the log line has tool, chainId, outcome, latencyMs, resultCount, protocolVersion, clientLabel and no arguments', () => {
    build(new FakeMcpUsageStore());

    events.onCall(call());

    expect(logging.info).toHaveBeenCalledTimes(1);
    expect(logging.info).toHaveBeenCalledWith({
      type: LogType.McpToolCall,
      tool: 'get_safe',
      chainId: '1',
      outcome: 'ok',
      latencyMs: 12,
      resultCount: 1,
      protocolVersion: '2026-07-28',
      clientLabel: 'claude-code',
    });
  });

  it('a call with chainId 99999999999 creates no field containing that value', async () => {
    const store = new FakeMcpUsageStore();
    build(store);

    events.onCall(call({ chainId: '99999999999', outcome: 'NOT_FOUND' }));
    await settle();

    expect(Object.keys(store.calls)).toEqual([
      'get_safe|unknown|claude-code|NOT_FOUND',
    ]);
    expect(JSON.stringify(logging.info.mock.calls)).not.toContain(
      '99999999999',
    );
  });

  it('a store failure does not fail the tool and logs one warning', async () => {
    const store = new FakeMcpUsageStore();
    jest.spyOn(store, 'incrementCall').mockRejectedValue(new Error('down'));
    build(store);

    expect(() => events.onCall(call())).not.toThrow();
    await settle();

    expect(logging.warn).toHaveBeenCalledTimes(1);
  });

  describe('with a store that never answers', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('returns at once and gives up with one warning', async () => {
      const hung = new Promise<never>(() => {});
      build({
        incrementCall: () => hung,
        addClient: () => hung,
        getDay: () => hung,
        getDailySalt: () => hung,
      });

      expect(() => events.onCall(call())).not.toThrow();
      expect(logging.warn).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(2000);

      expect(logging.warn).toHaveBeenCalledTimes(1);
    });
  });
});
