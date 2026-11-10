import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
} from '@nestjs/common';
import { z } from 'zod';
import { OrgTransaction } from '@/modules/org/db/org-transaction';
import { parse } from '@/modules/org/orgs/parse';
import { RequirePermission } from '@/modules/org/permissions/require-permission.decorator';
import type { Violation } from '@/modules/org/policies/evaluate';
import { OrgApiQuery } from '@/modules/org/common/org-api-body.decorator';

const FindingsQuerySchema = z.object({
  linkedSafeId: z.uuid().optional(),
  status: z.enum(['open', 'all']).default('open'),
});

// shortcut: newest 5000 open / 1000 overall, no paging; add a cursor if history needs it
const MAX_OPEN = 5000;
const MAX_ALL = 1000;

export type PolicyFinding = {
  id: string;
  linkedSafeId: string;
  chainId: string;
  safeAddress: string;
  safeTxHash: string;
  nonce: string;
  violations: Array<Violation>;
  firstSeenAt: Date;
  lastSeenAt: Date;
  resolvedAt: Date | null;
};

/** Policy warnings on queued transactions, written by the PolicyScanner. */
@Controller({ path: 'orgs/:orgId', version: '1' })
export class FindingsController {
  constructor(private readonly tx: OrgTransaction) {}

  @Get('policy-findings')
  @OrgApiQuery(FindingsQuerySchema)
  @RequirePermission('policies.view')
  list(
    @Param('orgId') orgId: string,
    @Query() query: unknown,
  ): Promise<Array<PolicyFinding>> {
    const { linkedSafeId, status } = parse(FindingsQuerySchema, query);
    return this.tx.runInOrgTx(async (em) => {
      if (linkedSafeId !== undefined) {
        const linked: Array<unknown> = await em.query(
          `SELECT 1 FROM linked_safes WHERE org_id = $1 AND id = $2`,
          [orgId, linkedSafeId],
        );
        if (linked.length === 0) throw new NotFoundException();
      }
      return em.query(
        `SELECT id, linked_safe_id AS "linkedSafeId", chain_id AS "chainId",
                safe_address::text AS "safeAddress", safe_tx_hash AS "safeTxHash",
                nonce::text AS nonce, violations, first_seen_at AS "firstSeenAt",
                last_seen_at AS "lastSeenAt", resolved_at AS "resolvedAt"
           FROM policy_findings
          WHERE org_id = $1
            AND ($2::uuid IS NULL OR linked_safe_id = $2)
            AND ($3 = 'all' OR resolved_at IS NULL)
          ORDER BY first_seen_at DESC, id
          LIMIT ${status === 'all' ? MAX_ALL : MAX_OPEN}`,
        [orgId, linkedSafeId ?? null, status],
      );
    }, orgId);
  }
}
