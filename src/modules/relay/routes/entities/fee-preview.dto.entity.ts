import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { z } from 'zod';
import { FeePreviewDtoSchema } from '@/modules/relay/routes/entities/schemas/fee-preview.dto.schema';
import { Operation } from '@/modules/safe/domain/entities/operation.entity';
import type { Address, Hex } from 'viem';

export class FeePreviewDto implements z.infer<typeof FeePreviewDtoSchema> {
  @ApiProperty()
  to!: Address;

  @ApiProperty()
  value!: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  data!: Hex | null;

  @ApiProperty({ enum: Operation })
  operation!: Operation;

  @ApiProperty({ description: 'Token the Safe pays the fee in' })
  gasToken!: Address;

  @ApiProperty({
    description: 'Signatures the execution will carry, usually the threshold',
  })
  numberSignatures!: number;

  @ApiPropertyOptional({
    description: 'Accepted for compatibility; costs are quoted in USD',
  })
  fiatCode?: string;
}
