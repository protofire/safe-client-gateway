import { Inject, Injectable } from '@nestjs/common';
import { IRelayManager } from '@/modules/relay/domain/interfaces/relay-manager.interface';
import { IRelayApi } from '@/domain/interfaces/relay-api.interface';
import { Relay } from '@/modules/relay/domain/entities/relay.entity';
import {
  RelayStatus,
  RelayStatusSchema,
} from '@/modules/relay/domain/entities/relay-status.entity';
import type { FeePreview } from '@/modules/relay/domain/entities/fee-preview.entity';
import { GasTokenRelayer } from '@/modules/relay/domain/relayers/gas-token.relayer';
import { GasTokenFeeService } from '@/modules/relay/domain/gas-token-fee.service';
import { RelayScreeningService } from '@/modules/relay/domain/sanctions/relay-screening.service';
import type { Operation } from '@/modules/safe/domain/entities/operation.entity';
import { keccak256, type Address, type Hex } from 'viem';
import { LogType } from '@/domain/common/entities/log-type.entity';
import { ILoggingService, LoggingService } from '@/logging/logging.interface';
import { asError } from '@/logging/utils';

@Injectable()
export class RelayRepository {
  constructor(
    @Inject(IRelayManager) private readonly relayManager: IRelayManager,
    @Inject(IRelayApi) private readonly relayApi: IRelayApi,
    private readonly gasTokenRelayer: GasTokenRelayer,
    private readonly feeService: GasTokenFeeService,
    private readonly relayScreeningService: RelayScreeningService,
    @Inject(LoggingService) private readonly loggingService: ILoggingService,
  ) {}

  async relay(args: {
    version: string;
    chainId: string;
    to: Address;
    data: Address;
    gasLimit: bigint | null;
  }): Promise<Relay> {
    // A non-zero gasPrice means the Safe refunds the executor: no quota, stricter checks
    const safePaysFee = this.gasTokenRelayer.getSafePaysFee(args.data);
    const isSafePays = safePaysFee !== null;
    // Every relay path passes here: OFAC screening before any relayer sees the transaction
    const screening = await this.relayScreeningService.screen({
      ...args,
      isSafePays,
    });
    const relayer = isSafePays
      ? this.gasTokenRelayer
      : this.relayManager.getRelayer(args.chainId);
    /*
     * Compliance record of every relayed transaction; the 10-year sink routes on
     * `type` (and SANCTIONS_SCREENING hits on `result`). No IPs or headers by design.
     * The logger nests events under its envelope: CloudWatch filters must use
     * `$.message.type` / `$.message.result`. Transfer amounts in SANCTIONS_SCREENING
     * are raw base units; resolve decimals from `token`.
     */
    const record = {
      type: LogType.RelayRecord,
      chainId: args.chainId,
      kind: isSafePays ? 'safe-pays' : 'sponsored',
      to: args.to,
      dataHash: keccak256(args.data),
      gasToken: safePaysFee?.gasToken ?? null,
      screening,
    };
    let relay: Relay;
    try {
      relay = await relayer.relay(args);
    } catch (error) {
      // A timeout or unparsable response may hide an accepted relay. Refusals land here too:
      // over-recording this minimal data is acceptable for compliance
      this.loggingService.info({
        ...record,
        taskId: null,
        outcome: 'unconfirmed',
        error: asError(error).message,
      });
      throw error;
    }
    this.loggingService.info({
      ...record,
      taskId: relay.taskId,
      outcome: 'accepted',
    });
    return relay;
  }

  async getRelayStatus(args: {
    chainId: string;
    taskId: string;
  }): Promise<RelayStatus> {
    return this.relayApi.getRelayStatus(args).then(RelayStatusSchema.parse);
  }

  async getRelaysRemaining(args: {
    chainId: string;
    address: Address;
  }): Promise<{ remaining: number; limit: number }> {
    return this.relayManager.getRelayer(args.chainId).getRelaysRemaining(args);
  }

  async previewFee(args: {
    chainId: string;
    safeAddress: Address;
    to: Address;
    value: string;
    data: Hex | null;
    operation: Operation;
    gasToken: Address;
    numberSignatures: number;
  }): Promise<FeePreview> {
    return this.feeService.preview(args);
  }

  async getGasTokenConfiguration(chainId: string): Promise<{
    gasTokens: Array<{ address: Address; symbol: string; decimals: number }>;
    refundReceiver: Address | null;
  }> {
    // A paused or underfunded relayer would refuse the relay: hide Safe-pays instead of offering it
    return (await this.feeService.isEnabled(chainId)) &&
      (await this.relayApi.isAvailable(chainId))
      ? await this.feeService.getConfiguration(chainId)
      : { gasTokens: [], refundReceiver: null };
  }
}
