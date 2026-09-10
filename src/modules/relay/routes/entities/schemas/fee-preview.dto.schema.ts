import { z } from 'zod';
import { TransactionBaseSchema } from '@/domain/common/schemas/transaction-base.schema';
import { AddressSchema } from '@/validation/entities/schemas/address.schema';
import { NullableHexSchema } from '@/validation/entities/schemas/nullable.schema';

export const FeePreviewDtoSchema = TransactionBaseSchema.extend({
  data: NullableHexSchema,
  gasToken: AddressSchema,
  numberSignatures: z.number().int().min(1),
  // Accepted for compatibility with the web app; costs are always quoted in USD
  fiatCode: z.string().optional(),
});
