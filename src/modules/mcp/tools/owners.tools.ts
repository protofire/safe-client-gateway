import { z } from 'zod';
import {
  defineTool,
  READ_ONLY_ANNOTATIONS,
  type McpTool,
} from '@/modules/mcp/tools/define-tool';
import type { McpFanoutLimit } from '@/modules/mcp/mcp-fanout-limit';
import { chainIdField } from '@/modules/mcp/tools/summaries';
import type { ISafeRepository } from '@/modules/safe/domain/safe.repository.interface';
import { AddressSchema } from '@/validation/entities/schemas/address.schema';

export const MAX_CHAIN_IDS = 5;
export const MAX_MULTISIGS = 100;

export function ownersTools(
  safeRepository: ISafeRepository,
  fanoutLimit: Pick<McpFanoutLimit, 'check'>,
): Array<McpTool> {
  return [
    defineTool({
      name: 'find_safes_by_owner',
      title: 'Find multisig accounts by owner',
      description: `Finds the multisig accounts an address owns, per chain. Prerequisite: the owner address; chainIds (at most ${MAX_CHAIN_IDS}, from list_chains) is optional and limits the lookup to those chains. Chains that failed are named in coverage, so an absent chain is not proof of no accounts; at most ${MAX_MULTISIGS} accounts are returned and truncated says when more exist. Next: get_safe for one account, then get_balances or list_queued_transactions.`,
      inputSchema: z.object({
        ownerAddress: AddressSchema.describe('Address of the owner'),
        chainIds: z
          .array(chainIdField)
          .min(1)
          .max(MAX_CHAIN_IDS)
          .optional()
          .describe('Chain ids to look up; omit to look up every chain'),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
      useful: true,
      handler: async ({ ownerAddress, chainIds }) => {
        const byChain: Record<string, Array<string> | null> = {};
        if (chainIds) {
          const unique = [...new Set(chainIds)];
          const settled = await Promise.allSettled(
            unique.map((chainId) =>
              safeRepository.getSafesByOwnerV2({ chainId, ownerAddress }),
            ),
          );
          settled.forEach((outcome, index) => {
            byChain[unique[index]] =
              outcome.status === 'fulfilled' ? outcome.value.safes : null;
          });
        } else {
          await fanoutLimit.check();
          Object.assign(
            byChain,
            await safeRepository.getAllSafesByOwnerV2({ ownerAddress }),
          );
        }

        const multisigs: Record<string, Array<string>> = {};
        const coverage: Array<{ chainId: string; error: 'unavailable' }> = [];
        let remaining = MAX_MULTISIGS;
        let truncated = false;
        for (const [chainId, safes] of Object.entries(byChain)) {
          if (safes === null) {
            coverage.push({ chainId, error: 'unavailable' });
            continue;
          }
          if (safes.length > remaining) {
            truncated = true;
          }
          const kept = safes.slice(0, remaining);
          remaining -= kept.length;
          if (kept.length > 0) {
            multisigs[chainId] = kept;
          }
        }
        return { multisigs, coverage, truncated };
      },
    }),
  ];
}
