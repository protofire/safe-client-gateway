import { FakeConfigurationService } from '@/config/__tests__/fake.configuration.service';
import { RelayManager } from '@/modules/relay/domain/relay.manager';
import type { DailyLimitRelayer } from '@/modules/relay/domain/relayers/daily-limit.relayer';
import type { NoFeeCampaignRelayer } from '@/modules/relay/domain/relayers/no-fee-campaign.relayer';

describe('RelayManager', () => {
  const dailyLimitRelayer = {} as DailyLimitRelayer;
  const noFeeCampaignRelayer = {} as NoFeeCampaignRelayer;

  const build = (sponsoredChains: Record<string, unknown>): RelayManager => {
    const config = new FakeConfigurationService();
    config.set('relay.noFeeCampaign', { 1: {}, 11155111: {} });
    config.set('relay.dailyLimitRelayerChainsIds', []);
    config.set('relay.sponsoredChains', sponsoredChains);
    return new RelayManager(config, dailyLimitRelayer, noFeeCampaignRelayer);
  };

  it('routes a sponsored chain to the daily limit relayer despite a no-fee campaign entry', () => {
    const target = build({ '11155111': {} });
    expect(target.getRelayer('11155111')).toBe(dailyLimitRelayer);
  });

  it('routes a no-fee campaign chain without a sponsored entry to the campaign relayer', () => {
    const target = build({ '84532': {} });
    expect(target.getRelayer('1')).toBe(noFeeCampaignRelayer);
    expect(target.getRelayer('84532')).toBe(dailyLimitRelayer);
  });
});
