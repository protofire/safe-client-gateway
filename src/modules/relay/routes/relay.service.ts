import { Injectable } from '@nestjs/common';
import { RelayRepository } from '@/modules/relay/domain/relay.repository';
import { RelayDto } from '@/modules/relay/routes/entities/relay.dto.entity';
import { Relay } from '@/modules/relay/routes/entities/relay.entity';
import { RelaysRemaining } from '@/modules/relay/routes/entities/relays-remaining.entity';
import { RelayStatus } from '@/modules/relay/routes/entities/relay-status.entity';
import { FeePreview } from '@/modules/relay/routes/entities/fee-preview.entity';
import { FeePreviewDto } from '@/modules/relay/routes/entities/fee-preview.dto.entity';
import type { Address } from 'viem';

@Injectable()
export class RelayService {
  constructor(private readonly relayRepository: RelayRepository) {}

  async relay(args: { chainId: string; relayDto: RelayDto }): Promise<Relay> {
    const relay = await this.relayRepository.relay({
      version: args.relayDto.version,
      chainId: args.chainId,
      to: args.relayDto.to,
      data: args.relayDto.data,
      gasLimit: args.relayDto.gasLimit,
    });

    return new Relay(relay);
  }

  async getRelayStatus(args: {
    chainId: string;
    taskId: string;
  }): Promise<RelayStatus> {
    const status = await this.relayRepository.getRelayStatus(args);
    return new RelayStatus(status);
  }

  async getRelaysRemaining(args: {
    chainId: string;
    safeAddress: Address;
  }): Promise<{ remaining: number; limit: number }> {
    const relaysRemaining = await this.relayRepository.getRelaysRemaining({
      chainId: args.chainId,
      address: args.safeAddress,
    });

    return new RelaysRemaining(relaysRemaining);
  }

  async previewFee(args: {
    chainId: string;
    safeAddress: Address;
    feePreviewDto: FeePreviewDto;
  }): Promise<FeePreview> {
    const { to, value, data, operation, gasToken, numberSignatures } =
      args.feePreviewDto;
    const preview = await this.relayRepository.previewFee({
      chainId: args.chainId,
      safeAddress: args.safeAddress,
      to,
      value,
      data,
      operation,
      gasToken,
      numberSignatures,
    });
    return new FeePreview(preview);
  }
}
