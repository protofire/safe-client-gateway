import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import {
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { FeePreview } from '@/modules/relay/routes/entities/fee-preview.entity';
import { FeePreviewDto } from '@/modules/relay/routes/entities/fee-preview.dto.entity';
import { FeePreviewDtoSchema } from '@/modules/relay/routes/entities/schemas/fee-preview.dto.schema';
import { RelayService } from '@/modules/relay/routes/relay.service';
import { AddressSchema } from '@/validation/entities/schemas/address.schema';
import { ValidationPipe } from '@/validation/pipes/validation.pipe';
import type { Address } from 'viem';

@ApiTags('relay')
@Controller({
  version: '1',
  path: 'chains/:chainId/fees',
})
export class FeesController {
  constructor(private readonly relayService: RelayService) {}

  @ApiOperation({
    summary: 'Preview a fee paid from the Safe',
    description:
      'Returns the gas fields (safeTxGas, baseGas, gasPrice, gasToken, refundReceiver) to include in a Safe transaction so the Safe pays the relayer in the given token, plus the native cost for display.',
  })
  @ApiParam({ name: 'chainId', type: 'string', example: '1' })
  @ApiParam({
    name: 'safeAddress',
    type: 'string',
    description: 'Safe that will pay the fee',
  })
  @ApiBody({ type: FeePreviewDto })
  @ApiOkResponse({ type: FeePreview })
  @ApiUnprocessableEntityResponse({
    description:
      'Token not accepted, chain not supported or price data unavailable',
  })
  @Post(':safeAddress/preview')
  @HttpCode(200)
  async previewFee(
    @Param('chainId') chainId: string,
    @Param('safeAddress', new ValidationPipe(AddressSchema))
    safeAddress: Address,
    @Body(new ValidationPipe(FeePreviewDtoSchema))
    feePreviewDto: FeePreviewDto,
  ): Promise<FeePreview> {
    return this.relayService.previewFee({
      chainId,
      safeAddress,
      feePreviewDto,
    });
  }
}
