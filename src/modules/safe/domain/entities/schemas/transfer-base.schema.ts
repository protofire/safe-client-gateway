import { z } from 'zod';
import { AddressSchema } from '@/validation/entities/schemas/address.schema';
import { HexSchema } from '@/validation/entities/schemas/hex.schema';
import { NullableStringSchema } from '@/validation/entities/schemas/nullable.schema';

export const TransferBaseSchema = z.object({
  executionDate: z.coerce.date(),
  blockNumber: z.number(),
  transactionHash: HexSchema,
  to: AddressSchema,
  from: AddressSchema,
  transferId: z.string(),
  // Only set for synthetic Hedera-native-transfer rows: `transactionHash`
  // for those is a service-generated placeholder (no real EVM transaction
  // exists to look up on a block explorer). Carries the real,
  // explorer-resolvable Hedera transaction id instead.
  hederaTransactionId: NullableStringSchema,
});
