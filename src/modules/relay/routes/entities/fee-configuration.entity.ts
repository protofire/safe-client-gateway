import { ApiProperty } from '@nestjs/swagger';
import type { Address } from 'viem';

export class FeeConfigurationToken {
  @ApiProperty()
  address!: Address;

  @ApiProperty()
  decimals!: number;
}

export class FeeConfiguration {
  @ApiProperty({ type: FeeConfigurationToken, isArray: true })
  gasTokens!: Array<FeeConfigurationToken>;

  @ApiProperty({ nullable: true })
  refundReceiver!: Address | null;
}
