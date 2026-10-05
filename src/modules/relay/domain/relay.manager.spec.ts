import type { IRelayManager } from '@/modules/relay/domain/interfaces/relay-manager.interface';
import { RelayManager } from '@/modules/relay/domain/relay.manager';
import type { DailyLimitRelayer } from '@/modules/relay/domain/relayers/daily-limit.relayer';

describe('RelayManager', () => {
  const dailyLimitRelayer = {} as DailyLimitRelayer;

  it('routes every chain to the daily limit relayer', () => {
    const target: IRelayManager = new RelayManager(dailyLimitRelayer);
    expect(target.getRelayer('11155111')).toBe(dailyLimitRelayer);
    expect(target.getRelayer('1')).toBe(dailyLimitRelayer);
    expect(target.getRelayer('84532')).toBe(dailyLimitRelayer);
  });
});
