import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  Transfer,
  TransferType,
} from '@/modules/transactions/routes/entities/transfers/transfer.entity';
import type { Address } from 'viem';

export class Src20Transfer extends Transfer {
  @ApiProperty({ enum: [TransferType.Src20] })
  override type = TransferType.Src20;
  @ApiProperty()
  tokenAddress: Address;
  @ApiProperty({
    description: 'Always "0" — SRC20 amounts are encrypted on-chain',
  })
  value: string;
  @ApiPropertyOptional({ type: String, nullable: true })
  tokenName: string | null;
  @ApiPropertyOptional({ type: String, nullable: true })
  tokenSymbol: string | null;
  @ApiPropertyOptional({ type: String, nullable: true })
  logoUri: string | null;
  @ApiPropertyOptional({ type: Number, nullable: true })
  decimals: number | null;
  @ApiPropertyOptional({ type: Boolean, nullable: true })
  trusted: boolean | null;
  @ApiProperty({
    description:
      'Amount is encrypted; clients should render "N/A" instead of value',
  })
  encrypted: boolean;

  constructor(
    tokenAddress: Address,
    tokenName: string | null = null,
    tokenSymbol: string | null = null,
    logoUri: string | null = null,
    decimals: number | null = null,
    trusted: boolean | null = null,
  ) {
    super(TransferType.Src20);
    this.tokenAddress = tokenAddress;
    // SRC20 amounts are encrypted on-chain, so the value is never meaningful
    // and is always reported as "0". Owning the constant here keeps every
    // mapper consistent and prevents an encrypted amount from leaking.
    this.value = '0';
    this.tokenName = tokenName;
    this.tokenSymbol = tokenSymbol;
    this.logoUri = logoUri;
    this.decimals = decimals;
    this.trusted = trusted;
    this.encrypted = true;
  }
}

export function isSrc20Transfer(transfer: Transfer): transfer is Src20Transfer {
  return transfer.type === TransferType.Src20;
}
