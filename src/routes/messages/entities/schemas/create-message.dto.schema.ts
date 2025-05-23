import { z } from 'zod';

export const CreateMessageDtoSchema = z.object({
  message: z.union([z.record(z.unknown()), z.string()]),
  safeAppId: z.number().int().gte(0).nullish().default(null),
  signature: z.string(),
  origin: z.string().nullish().default(null),
});
