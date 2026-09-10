import { ApiProperty } from '@nestjs/swagger';
import type { FeePreview as DomainFeePreview } from '@/modules/relay/domain/entities/fee-preview.entity';
import type { Address } from 'viem';

export class FeePreviewTxData {
  @ApiProperty()
  chainId!: string;

  @ApiProperty()
  safeAddress!: Address;

  @ApiProperty()
  safeTxGas!: string;

  @ApiProperty()
  baseGas!: string;

  @ApiProperty({
    description: 'Price per gas unit in the smallest unit of gasToken',
  })
  gasPrice!: string;

  @ApiProperty()
  gasToken!: Address;

  @ApiProperty()
  refundReceiver!: Address;

  @ApiProperty()
  numberSignatures!: number;
}

export class FeePreviewRelayCost {
  @ApiProperty()
  fiatCode!: string;

  @ApiProperty({ description: 'Native gas cost at quote time, for display' })
  fiatValue!: string;
}

export class FeePreviewPricingContext {
  @ApiProperty()
  phase!: number;

  @ApiProperty()
  priceSource!: string;

  @ApiProperty({ description: 'Unix seconds' })
  priceTimestamp!: number;

  @ApiProperty({ description: 'Multiplier applied to the native gas cost' })
  gasPriceVolatilityBuffer!: number;
}

export class FeePreview implements DomainFeePreview {
  @ApiProperty({ type: FeePreviewTxData })
  txData: FeePreviewTxData;

  @ApiProperty({ type: FeePreviewRelayCost })
  relayCost: FeePreviewRelayCost;

  @ApiProperty({ type: FeePreviewPricingContext })
  pricingContextSnapshot: FeePreviewPricingContext;

  constructor(feePreview: DomainFeePreview) {
    this.txData = feePreview.txData;
    this.relayCost = feePreview.relayCost;
    this.pricingContextSnapshot = feePreview.pricingContextSnapshot;
  }
}
