import { z } from 'zod';
import { AddressSchema } from '@/validation/entities/schemas/address.schema';
import { TransferBaseSchema } from '@/modules/safe/domain/entities/schemas/transfer-base.schema';

export const Src20TransferSchema = TransferBaseSchema.extend({
  type: z.literal('SRC20_TRANSFER'),
  // SRC20 amounts are encrypted on-chain and are never surfaced — Src20Transfer always
  // reports "0". This upstream field is therefore optional and unused by the gateway; the
  // encrypted-amount invariant is enforced solely in the Src20Transfer entity.
  value: z.string().optional(),
  tokenAddress: AddressSchema,
});
