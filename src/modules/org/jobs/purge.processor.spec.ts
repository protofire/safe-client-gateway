import type { ILoggingService } from '@/logging/logging.interface';
import { systemClock } from '@/modules/org/common/clock';
import type { OrgTransaction } from '@/modules/org/db/org-transaction';
import { PurgeProcessor } from '@/modules/org/jobs/purge.processor';

describe('PurgeProcessor schedule', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('runs once a minute after boot, then hourly', () => {
    const p = new PurgeProcessor({} as OrgTransaction, systemClock, {
      error: jest.fn(),
    } as unknown as ILoggingService);
    const run = jest.spyOn(p, 'run').mockResolvedValue();

    p.onApplicationBootstrap();
    jest.advanceTimersByTime(59_000);
    expect(run).toHaveBeenCalledTimes(0);
    jest.advanceTimersByTime(1_000);
    expect(run).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(3600_000);
    expect(run).toHaveBeenCalledTimes(2);

    p.onModuleDestroy();
    jest.advanceTimersByTime(3 * 3600_000);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
