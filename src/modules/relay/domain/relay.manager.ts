import { Inject, Injectable } from '@nestjs/common';
import { IRelayManager } from '@/modules/relay/domain/interfaces/relay-manager.interface';
import { IRelayer } from '@/modules/relay/domain/interfaces/relayer.interface';
import { DailyLimitRelayer } from '@/modules/relay/domain/relayers/daily-limit.relayer';
import { NoFeeCampaignRelayer } from '@/modules/relay/domain/relayers/no-fee-campaign.relayer';
import { IConfigurationService } from '@/config/configuration.service.interface';
import { NoFeeCampaignConfiguration } from '@/modules/relay/domain/entities/relay.configuration';
import type { SponsoredChainsConfiguration } from '@/modules/relay/domain/entities/sponsored-chains.configuration';

@Injectable()
export class RelayManager implements IRelayManager {
  private readonly noFeeCampaignConfiguration: NoFeeCampaignConfiguration;
  private readonly dailyLimitRelayChainIds: Array<string>;
  private readonly sponsoredChains: SponsoredChainsConfiguration;
  constructor(
    @Inject(IConfigurationService) configurationService: IConfigurationService,
    private readonly dailyLimitRelayer: DailyLimitRelayer,
    private readonly noFeeCampaignRelayer: NoFeeCampaignRelayer,
  ) {
    this.noFeeCampaignConfiguration = configurationService.getOrThrow(
      'relay.noFeeCampaign',
    );

    this.dailyLimitRelayChainIds = configurationService.getOrThrow(
      'relay.dailyLimitRelayerChainsIds',
    );

    this.sponsoredChains = configurationService.getOrThrow(
      'relay.sponsoredChains',
    );
  }

  public getRelayer(chainId: string): IRelayer {
    // Sponsored chains and chains configured for the daily limit relayer win over no-fee campaign defaults
    if (
      this.sponsoredChains[chainId] ||
      this.dailyLimitRelayChainIds.includes(chainId)
    ) {
      return this.dailyLimitRelayer;
    }

    const noFeeCampaignConfigurationPerChain =
      this.noFeeCampaignConfiguration[parseInt(chainId)];

    // If chain has no-fee campaign configuration, use no-fee campaign relayer
    if (noFeeCampaignConfigurationPerChain !== undefined) {
      return this.noFeeCampaignRelayer;
    }

    // Fallback, to use daily limit relayer. This is to ensure backward compatibility if dailyLimitRelayChainIds is not set becuase of missing environment variable.
    return this.dailyLimitRelayer;
  }
}
