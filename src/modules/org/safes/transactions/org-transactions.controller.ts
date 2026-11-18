import { Controller, Get, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { OrgSession } from '@/modules/org/auth/decorators';
import { OrgApiQuery } from '@/modules/org/common/org-api-body.decorator';
import { RateLimiter } from '@/modules/org/common/rate-limiter';
import { parse } from '@/modules/org/orgs/parse';
import { RequirePermission } from '@/modules/org/permissions/require-permission.decorator';
import { MAX_CURSOR_BYTES } from '@/modules/org/safes/transactions/cursor';
import {
  OrgTransactionsService,
  type ListResponse,
} from '@/modules/org/safes/transactions/org-transactions.service';
import type { Counts } from '@/modules/org/safes/transactions/queue-page';
import { KINDS } from '@/modules/org/safes/transactions/tx-kind';

const MAX_REPEATED = 50;
// spec §5: shared by the list and the counts, each a fan-out over up to 50 Safes
const REQUESTS_PER_USER_PER_MINUTE = 60;

const LinkedSafeId = z.uuid();
const ChainId = z.string().regex(/^[1-9]\d{0,19}$/);
const Kind = z.enum(KINDS);

/** `?x=a&x=b` arrives as an array, a single `?x=a` as a string. */
const repeated = <T extends z.ZodType>(
  item: T,
): z.ZodOptional<z.ZodPipe<z.ZodTransform, z.ZodArray<T>>> =>
  z
    .preprocess(
      (v) => (Array.isArray(v) ? v : [v]),
      z.array(item).min(1).max(MAX_REPEATED),
    )
    .optional();

const ScopeSchema = z.object({
  linkedSafeId: repeated(LinkedSafeId),
  chainId: repeated(ChainId),
});
const ListSchema = ScopeSchema.extend({
  tab: z.enum(['queue', 'history']),
  mine: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  kind: repeated(Kind),
  limit: z.coerce.number().int().min(1).max(50).default(25),
  cursor: z.string().min(1).max(MAX_CURSOR_BYTES).optional(),
});

// OpenAPI only: the repeatable parameters as the arrays the preprocess accepts
const many = <T extends z.ZodType>(item: T): z.ZodOptional<z.ZodArray<T>> =>
  z.array(item).max(MAX_REPEATED).optional();
const ScopeDoc = ScopeSchema.extend({
  linkedSafeId: many(LinkedSafeId),
  chainId: many(ChainId),
});
const ListDoc = ListSchema.extend({
  linkedSafeId: many(LinkedSafeId),
  chainId: many(ChainId),
  kind: many(Kind),
});

/** Spec 027 §5: executed and queued multisig transactions of the org's linked Safes. */
@Controller({ path: 'orgs/:orgId', version: '1' })
export class OrgTransactionsController {
  constructor(
    private readonly transactions: OrgTransactionsService,
    private readonly rateLimiter: RateLimiter,
  ) {}

  @Get('transactions')
  @OrgApiQuery(ListDoc)
  @RequirePermission('safes.view')
  async list(
    @Req() req: Request,
    @OrgSession() session: OrgSession,
    @Query() query: unknown,
  ): Promise<ListResponse> {
    const q = parse(ListSchema, query);
    await this.limit(session.userId);
    return this.transactions.list(req.params.orgId, session.userId, q);
  }

  @Get('transactions/counts')
  @OrgApiQuery(ScopeDoc)
  @RequirePermission('safes.view')
  async counts(
    @Req() req: Request,
    @OrgSession() session: OrgSession,
    @Query() query: unknown,
  ): Promise<Counts> {
    const q = parse(ScopeSchema, query);
    await this.limit(session.userId);
    return this.transactions.counts(req.params.orgId, session.userId, q);
  }

  private limit(userId: string): Promise<void> {
    return this.rateLimiter.enforce(
      `transactions:user:${userId}`,
      REQUESTS_PER_USER_PER_MINUTE,
      60,
    );
  }
}
