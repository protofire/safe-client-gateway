import {
  PayoutRunsService,
  sanitizeReason,
  SIMULATION_TIMEOUT_MS,
  assertRunSize,
} from '@/modules/org/payouts/payout-runs.service';
import { toCall } from '@/modules/org/payouts/payout-calls';

describe('sanitizeReason', () => {
  it('strips control characters including NUL', () => {
    expect(sanitizeReason('a\u0000b\u001fc\nd\u007fe')).toBe('abcde');
  });

  it('bounds to 200 and never ends on a lone surrogate', () => {
    const cut = `${'x'.repeat(199)}😀`; // the emoji straddles the boundary
    const out = sanitizeReason(cut);
    expect(out).toBe('x'.repeat(199) + '\uFFFD');
    expect(out.isWellFormed()).toBe(true);
    expect(out.length).toBe(200);
  });
});

describe('assertRunSize', () => {
  it('prorates maxRecipients to at least 1', () => {
    const calls = [
      toCall({
        recipient: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
        token: 'native',
        amountRaw: 1n,
      }),
    ];
    let thrown: { response?: { maxRecipients?: number } } = {};
    try {
      assertRunSize(calls, 1_000_000_000n);
    } catch (e) {
      thrown = e as typeof thrown;
    }
    expect(thrown.response?.maxRecipients).toBe(1);
  });
});

describe('PayoutRunsService.simulate deadline', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('resolves null when the simulation never settles', async () => {
    const svc = Object.create(PayoutRunsService.prototype) as PayoutRunsService;
    jest
      .spyOn(svc as never, 'simulateOnChain')
      .mockReturnValue(new Promise(() => undefined) as never);
    const result = svc.simulate(
      '1',
      '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
      [],
    );
    await jest.advanceTimersByTimeAsync(SIMULATION_TIMEOUT_MS);
    await expect(result).resolves.toBeNull();
  });
});
