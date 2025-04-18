import { Module } from '@nestjs/common';
import { LimitAddressesMapper } from '@/domain/relay/limit-addresses.mapper';
import { RelayRepository } from '@/domain/relay/relay.repository';
import { RelayApiModule } from '@/datasources/relay-api/relay-api.module';
import { RelayDecodersModule } from '@/domain/relay/relay-decoders.module';
import { SafeRepositoryModule } from '@/domain/safe/safe.repository.interface';
import { DelayModifierDecoder } from '@/domain/alerts/contracts/decoders/delay-modifier-decoder.helper';

@Module({
  imports: [RelayApiModule, RelayDecodersModule, SafeRepositoryModule],
  providers: [LimitAddressesMapper, RelayRepository, DelayModifierDecoder],
  exports: [RelayRepository],
})
export class RelayDomainModule {}
