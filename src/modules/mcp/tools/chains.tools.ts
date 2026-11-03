import { z } from 'zod';
import type { IChainsRepository } from '@/modules/chains/domain/chains.repository.interface';
import {
  defineTool,
  READ_ONLY_ANNOTATIONS,
  type McpTool,
} from '@/modules/mcp/tools/define-tool';

// Proposing and the Transaction Builder arrive with phase 2
const CAPABILITIES = { read: true, propose: false, txBuilder: false };

export function chainsTools(
  chainsRepository: IChainsRepository,
): Array<McpTool> {
  return [
    defineTool({
      name: 'list_chains',
      title: 'List chains',
      description:
        'Lists the chains this server reads, with chainId, name, recommended contract version and capabilities. No prerequisites. Next: pass a chainId to get_safe.',
      inputSchema: z.object({}),
      annotations: READ_ONLY_ANNOTATIONS,
      useful: false,
      handler: async () => {
        const chains = await chainsRepository.getAllChains();
        return {
          results: chains.map((chain) => ({
            chainId: chain.chainId,
            name: chain.chainName,
            recommendedVersion: chain.recommendedMasterCopyVersion,
            capabilities: CAPABILITIES,
          })),
        };
      },
    }),
  ];
}
