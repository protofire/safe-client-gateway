import {
  ApiExtraModels,
  ApiProperty,
  ApiPropertyOptional,
  getSchemaPath,
} from '@nestjs/swagger';
import { SafeAppInfo } from '@/modules/transactions/routes/entities/safe-app-info.entity';
import { TransactionData } from '@/modules/transactions/routes/entities/transaction-data.entity';
import { ModuleExecutionDetails } from '@/modules/transactions/routes/entities/transaction-details/module-execution-details.entity';
import { MultisigExecutionDetails } from '@/modules/transactions/routes/entities/transaction-details/multisig-execution-details.entity';
import { BaseTransaction } from '@/modules/transactions/routes/entities/base-transaction.entity';
import { TransactionStatus } from '@/modules/transactions/routes/entities/transaction-status.entity';

@ApiExtraModels(
  TransactionData,
  MultisigExecutionDetails,
  ModuleExecutionDetails,
  SafeAppInfo,
)
export class TransactionDetails extends BaseTransaction {
  @ApiProperty()
  safeAddress!: string;
  @ApiProperty()
  txId!: string;
  @ApiPropertyOptional({ type: Number, nullable: true })
  executedAt!: number | null;
  @ApiProperty({ enum: TransactionStatus })
  txStatus!: TransactionStatus;
  @ApiPropertyOptional({ type: TransactionData, nullable: true })
  txData!: TransactionData | null;
  @ApiPropertyOptional({
    oneOf: [
      { $ref: getSchemaPath(MultisigExecutionDetails) },
      { $ref: getSchemaPath(ModuleExecutionDetails) },
    ],
    nullable: true,
  })
  detailedExecutionInfo!:
    | MultisigExecutionDetails
    | ModuleExecutionDetails
    | null;
  @ApiPropertyOptional({ type: String, nullable: true })
  txHash!: string | null;
  @ApiPropertyOptional({ type: SafeAppInfo, nullable: true })
  safeAppInfo!: SafeAppInfo | null;
  @ApiPropertyOptional({ type: String, nullable: true })
  note!: string | null;
  // Only present for synthetic Hedera-native-transfer transactions: `txHash`
  // for those is a service-generated placeholder (no real EVM transaction
  // exists to look up on a block explorer). Carries the real,
  // explorer-resolvable Hedera transaction id instead. Omitted from the
  // response otherwise.
  @ApiPropertyOptional({ type: String })
  hederaTransactionId?: string;
}
