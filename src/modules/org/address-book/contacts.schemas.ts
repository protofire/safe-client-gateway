import { getAddress, isAddress } from 'viem';
import { z } from 'zod';

export const MAX_CONTACTS = 1000;
export const MAX_CHAINS = 100;
export const MAX_PENDING_PER_ORG = 100;
export const MAX_PENDING_PER_REQUESTER = 20;

const name = z.string().trim().min(1).max(64);
const address = z
  .string()
  .refine((v) => isAddress(v, { strict: false }), 'Invalid address')
  .transform((v) => getAddress(v));
const chainIds = z
  .array(z.string().regex(/^[1-9]\d{0,17}$/))
  .min(1)
  .max(MAX_CHAINS)
  .transform((v) => [...new Set(v)]);
const tags = z
  .array(z.string().trim().min(1).max(32))
  .max(10)
  .transform((v) => [...new Set(v.map((t) => t.toLowerCase()))]);

export const ContactSchema = z.object({
  name,
  address,
  chainIds,
  tags: tags.default([]),
});
export const ContactPatchSchema = z
  .object({ name, address, chainIds, tags })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to change');

export type ContactInput = z.infer<typeof ContactSchema>;
export type ContactPatch = z.infer<typeof ContactPatchSchema>;

export const ListQuerySchema = z.object({
  search: z.string().trim().min(1).max(100).optional(),
  tag: z.string().trim().toLowerCase().min(1).max(32).optional(),
  chainId: z
    .string()
    .regex(/^[1-9]\d{0,17}$/)
    .optional(),
});

export const CreateRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create'), payload: ContactSchema }),
  z.object({
    action: z.literal('update'),
    contactId: z.uuid(),
    payload: ContactPatchSchema,
  }),
  z.object({
    action: z.literal('delete'),
    contactId: z.uuid(),
    payload: z.object({}).optional(),
  }),
]);

export const RequestsQuerySchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'all']).default('pending'),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type Contact = {
  id: string;
  name: string;
  address: string;
  chainIds: Array<string>;
  tags: Array<string>;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type Actor = {
  userId: string;
  ip?: string;
  userAgent?: string;
};
