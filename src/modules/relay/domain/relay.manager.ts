import { Injectable } from '@nestjs/common';
import { IRelayManager } from '@/modules/relay/domain/interfaces/relay-manager.interface';
import { IRelayer } from '@/modules/relay/domain/interfaces/relayer.interface';
import { DailyLimitRelayer } from '@/modules/relay/domain/relayers/daily-limit.relayer';

@Injectable()
export class RelayManager implements IRelayManager {
  constructor(private readonly dailyLimitRelayer: DailyLimitRelayer) {}

  public getRelayer(): IRelayer {
    // Every chain uses the daily limit relayer; config-service sponsoring settings decide per chain
    return this.dailyLimitRelayer;
  }
}
