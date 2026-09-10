import { Module } from '@nestjs/common';
import { LimitAddressesMapper } from '@/modules/relay/domain/limit-addresses.mapper';
import { RelayRepository } from '@/modules/relay/domain/relay.repository';
import { RelayApiModule } from '@/modules/relay/datasources/relay-api.module';
import { RelayDecodersModule } from '@/modules/relay/domain/relay-decoders.module';
import { SafeRepositoryModule } from '@/modules/safe/domain/safe.repository.interface';
import { DelayModifierDecoder } from '@/modules/alerts/domain/contracts/decoders/delay-modifier-decoder.helper';
import { BalancesModule } from '@/modules/balances/balances.module';
import { BlockchainModule } from '@/modules/blockchain/blockchain.module';
import { ChainsModule } from '@/modules/chains/chains.module';
import { EstimationsModule } from '@/modules/estimations/estimations.module';
import { DailyLimitRelayer } from '@/modules/relay/domain/relayers/daily-limit.relayer';
import { NoFeeCampaignRelayer } from '@/modules/relay/domain/relayers/no-fee-campaign.relayer';
import { GasTokenRelayer } from '@/modules/relay/domain/relayers/gas-token.relayer';
import { GasTokenFeeService } from '@/modules/relay/domain/gas-token-fee.service';
import { RelayManager } from '@/modules/relay/domain/relay.manager';
import { IRelayManager } from '@/modules/relay/domain/interfaces/relay-manager.interface';

@Module({
  imports: [
    RelayApiModule,
    RelayDecodersModule,
    SafeRepositoryModule,
    BalancesModule,
    BlockchainModule,
    ChainsModule,
    EstimationsModule,
  ],
  providers: [
    LimitAddressesMapper,
    RelayRepository,
    DelayModifierDecoder,
    DailyLimitRelayer,
    NoFeeCampaignRelayer,
    GasTokenFeeService,
    GasTokenRelayer,
    {
      provide: IRelayManager,
      useClass: RelayManager,
    },
  ],
  exports: [RelayRepository],
})
export class RelayDomainModule {}
