import { zeroAddress } from 'viem';
import { z } from 'zod';
import {
  defineTool,
  McpToolError,
  READ_ONLY_ANNOTATIONS,
  type McpTool,
} from '@/modules/mcp/tools/define-tool';
import type { ISafeRepository } from '@/modules/safe/domain/safe.repository.interface';
import { AddressSchema } from '@/validation/entities/schemas/address.schema';
import { NumericStringSchema } from '@/validation/entities/schemas/numeric-string.schema';

function riskNotes(args: {
  owners: Array<string>;
  threshold: number;
  modules: Array<string>;
  guard: string;
}): Array<string> {
  const notes: Array<string> = [];
  if (args.threshold === 1) {
    notes.push('Threshold is 1: a single owner can execute transactions.');
  }
  if (args.threshold === args.owners.length) {
    notes.push(
      'Threshold equals the owner count: every owner must sign, so one lost key blocks the account.',
    );
  }
  if (args.modules.length > 0) {
    notes.push(
      `${args.modules.length} module(s) enabled: a module can execute transactions without owner signatures.`,
    );
  }
  if (args.guard !== zeroAddress) {
    notes.push(
      'A guard is set: it checks every transaction and can block execution.',
    );
  }
  return notes;
}

export function safeTools(safeRepository: ISafeRepository): Array<McpTool> {
  return [
    defineTool({
      name: 'get_safe',
      title: 'Get multisig account',
      description:
        'Reads a multisig account: owners, threshold, nonce, version, modules, guard, fallback handler and riskNotes. Prerequisite: a chainId from list_chains and the account address.',
      inputSchema: z.object({
        chainId: NumericStringSchema.describe(
          'Chain id as a decimal string, from list_chains',
        ),
        safeAddress: AddressSchema.describe('Address of the multisig account'),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
      useful: true,
      handler: async ({ chainId, safeAddress }) => {
        const {
          owners,
          threshold,
          nonce,
          version,
          modules,
          guard,
          fallbackHandler,
        } = await safeRepository.getSafe({ chainId, address: safeAddress });
        if (modules === null) {
          throw new McpToolError(
            'UPSTREAM_ERROR',
            'Could not read the modules of this account. Retry later.',
          );
        }
        return {
          owners,
          threshold,
          nonce,
          version,
          modules,
          guard,
          fallbackHandler,
          riskNotes: riskNotes({ owners, threshold, modules, guard }),
        };
      },
    }),
  ];
}
