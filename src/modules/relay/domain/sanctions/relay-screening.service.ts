import { Inject, Injectable } from '@nestjs/common';
import { keccak256, type Address, type Hex } from 'viem';
import { LogType } from '@/domain/common/entities/log-type.entity';
import {
  LoggingService,
  type ILoggingService,
} from '@/logging/logging.interface';
import {
  SanctionsListService,
  type SanctionsListVersion,
} from '@/modules/relay/domain/sanctions/sanctions-list.service';
import { ScreeningAddressesMapper } from '@/modules/relay/domain/sanctions/screening-addresses.mapper';
import {
  SanctionsListUnavailableError,
  SanctionsScreeningError,
} from '@/modules/relay/domain/errors/sanctions-screening.error';

/** What a relayed transaction was screened against, for its RELAY_RECORD. */
export type ScreeningOutcome =
  | { result: 'clear'; list: SanctionsListVersion | null }
  | 'disabled';

// Keeps a hit event far below CloudWatch's 256 KB event limit; transfersTotal shows what was cut
const MAX_LOGGED_TRANSFERS = 100;

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
  }): Promise<ScreeningOutcome> {
    if (!this.sanctionsList.isEnabled()) {
      // Screening off must not skip the nested-refund guard: it runs on its own
      this.screeningAddressesMapper.assertNoNestedRefund(args.data);
      return 'disabled';
    }
    const { screened, transfers } =
      await this.screeningAddressesMapper.map(args);
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
      return { result: 'clear', list: check.list };
    }
    // A refused hit keeps what the rejected-transaction report needs; clear events stay small
    this.loggingService.warn(
      check.result === 'hit'
        ? {
            ...event,
            transfers: transfers.slice(0, MAX_LOGGED_TRANSFERS),
            transfersTotal: transfers.length,
          }
        : event,
    );
    throw check.result === 'hit'
      ? new SanctionsScreeningError()
      : new SanctionsListUnavailableError();
  }
}
