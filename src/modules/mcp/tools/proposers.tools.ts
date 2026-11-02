import { z } from 'zod';
import type { IDelegatesV2Repository } from '@/modules/delegate/domain/v2/delegates.v2.repository.interface';
import {
  defineTool,
  READ_ONLY_ANNOTATIONS,
  type McpTool,
} from '@/modules/mcp/tools/define-tool';
import { PAGE_SIZE } from '@/modules/mcp/tools/summaries';
import { AddressSchema } from '@/validation/entities/schemas/address.schema';
import { NumericStringSchema } from '@/validation/entities/schemas/numeric-string.schema';

const SCOPE_NOTE =
  'Lists the delegates registered for this multisig account only. Delegates registered for an owner across all accounts are not included.';

export function proposersTools(
  delegatesRepository: IDelegatesV2Repository,
): Array<McpTool> {
  return [
    defineTool({
      name: 'list_proposers',
      title: 'List proposers',
      description: `Lists who may propose transactions to a multisig account without being an owner: delegate, delegator and label. Only delegates scoped to this account are listed; at most ${PAGE_SIZE}, truncated says when more exist. Prerequisite: chainId from list_chains and the account address. Next: get_safe for the owners, list_queued_transactions for what was proposed.`,
      inputSchema: z.object({
        chainId: NumericStringSchema.describe(
          'Chain id as a decimal string, from list_chains',
        ),
        safeAddress: AddressSchema.describe('Address of the multisig account'),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
      useful: true,
      handler: async ({ chainId, safeAddress }) => {
        const page = await delegatesRepository.getDelegates({
          chainId,
          safeAddress,
          limit: PAGE_SIZE,
        });
        return {
          scope: SCOPE_NOTE,
          truncated: page.next !== null,
          results: page.results.map(({ delegate, delegator, label }) => ({
            delegate,
            delegator,
            label,
          })),
        };
      },
    }),
  ];
}
