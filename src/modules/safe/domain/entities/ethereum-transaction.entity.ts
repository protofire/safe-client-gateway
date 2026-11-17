import { TransferSchema } from '@/modules/safe/domain/entities/transfer.entity';
import { AddressSchema } from '@/validation/entities/schemas/address.schema';
import { HexSchema } from '@/validation/entities/schemas/hex.schema';
import { z } from 'zod';
import {
  NullableHexSchema,
  NullableStringSchema,
} from '@/validation/entities/schemas/nullable.schema';

export type EthereumTransaction = z.infer<typeof EthereumTransactionSchema>;

export const EthereumTransactionSchema = z.object({
  executionDate: z.coerce.date(),
  data: NullableHexSchema,
  txHash: HexSchema,
  blockNumber: z.number(),
  transfers: z.array(TransferSchema).nullish().default(null),
  from: AddressSchema,
  // Only set for synthetic Hedera-native-transfer rows: `txHash` for those
  // is a service-generated placeholder (no real EVM transaction exists to
  // look up on a block explorer). Carries the real, explorer-resolvable
  // Hedera transaction id (e.g. "0.0.X-<seconds>-<nanos>") instead.
  hederaTransactionId: NullableStringSchema,
});

export const EthereumTransactionTypeSchema = EthereumTransactionSchema.extend({
  txType: z.literal('ETHEREUM_TRANSACTION'),
});
