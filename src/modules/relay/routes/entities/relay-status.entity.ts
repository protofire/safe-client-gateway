import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  RelayStatusCode,
  type RelayStatus as DomainRelayStatus,
} from '@/modules/relay/domain/entities/relay-status.entity';

export class RelayReceipt {
  @ApiProperty()
  transactionHash: string;

  constructor(transactionHash: string) {
    this.transactionHash = transactionHash;
  }
}

export class RelayStatus implements DomainRelayStatus {
  @ApiProperty({
    enum: RelayStatusCode,
    description:
      '100 pending, 110 submitted, 200 included, 400 rejected, 500 reverted',
  })
  status: RelayStatusCode;

  @ApiPropertyOptional({ type: RelayReceipt })
  receipt?: RelayReceipt;

  constructor(relayStatus: DomainRelayStatus) {
    this.status = relayStatus.status;
    if (relayStatus.receipt) {
      this.receipt = new RelayReceipt(relayStatus.receipt.transactionHash);
    }
  }
}
