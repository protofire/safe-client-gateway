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
import type { Operation } from '@/modules/safe/domain/entities/operation.entity';
import type { Address, Hex } from 'viem';

@Injectable()
export class RelayRepository {
  constructor(
    @Inject(IRelayManager) private readonly relayManager: IRelayManager,
    @Inject(IRelayApi) private readonly relayApi: IRelayApi,
    private readonly gasTokenRelayer: GasTokenRelayer,
    private readonly feeService: GasTokenFeeService,
  ) {}

  async relay(args: {
    version: string;
    chainId: string;
    to: Address;
    data: Address;
    gasLimit: bigint | null;
  }): Promise<Relay> {
    // A non-zero gasPrice means the Safe refunds the executor: no quota, stricter checks
    const relayer = this.gasTokenRelayer.getSafePaysFee(args.data)
      ? this.gasTokenRelayer
      : this.relayManager.getRelayer(args.chainId);
    return relayer.relay(args);
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
}
