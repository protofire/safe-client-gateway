import { Inject, Injectable } from '@nestjs/common';
import { keccak256, type Address, type Hex } from 'viem';
import { LogType } from '@/domain/common/entities/log-type.entity';
import {
  LoggingService,
  type ILoggingService,
} from '@/logging/logging.interface';
import { SanctionsListService } from '@/modules/relay/domain/sanctions/sanctions-list.service';
import { ScreeningAddressesMapper } from '@/modules/relay/domain/sanctions/screening-addresses.mapper';
import {
  SanctionsListUnavailableError,
  SanctionsScreeningError,
} from '@/modules/relay/domain/errors/sanctions-screening.error';

@Injectable()
export class RelayScreeningService {
  constructor(
    private readonly sanctionsList: SanctionsListService,
    private readonly screeningAddressesMapper: ScreeningAddressesMapper,
    @Inject(LoggingService) private readonly loggingService: ILoggingService,
  ) {}

  async screen(args: {
    version: string;
    chainId: string;
    to: Address;
    data: Hex;
    isSafePays: boolean;
  }): Promise<void> {
    if (!this.sanctionsList.isEnabled()) {
      // Screening off must not skip the nested-refund guard: it runs on its own
      this.screeningAddressesMapper.assertNoNestedRefund(args.data);
      return;
    }
    const screened = await this.screeningAddressesMapper.map(args);
    const unique = [...new Set(screened.map((s) => s.address))];
    const check = this.sanctionsList.check(unique);
    // Audit record of every check (10-year sink routes on this type); no IPs by design
    const event = {
      type: LogType.SanctionsScreening,
      chainId: args.chainId,
      to: args.to,
      dataHash: keccak256(args.data),
      screened,
      result: check.result,
      matches: check.matches,
      list: check.list,
      at: new Date().toISOString(),
    };

    if (check.result === 'clear') {
      this.loggingService.info(event);
      return;
    }
    this.loggingService.warn(event);
    throw check.result === 'hit'
      ? new SanctionsScreeningError()
      : new SanctionsListUnavailableError();
  }
}
