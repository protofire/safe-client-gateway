import { z } from 'zod';
import type { BalancesService } from '@/modules/balances/routes/balances.service';
import {
  defineTool,
  READ_ONLY_ANNOTATIONS,
  type McpTool,
} from '@/modules/mcp/tools/define-tool';
import { AddressSchema } from '@/validation/entities/schemas/address.schema';
import { NumericStringSchema } from '@/validation/entities/schemas/numeric-string.schema';

export const MAX_BALANCES = 50;
const FIAT_CODE = 'USD';

export function balancesTools(
  balancesService: Pick<BalancesService, 'getBalances'>,
): Array<McpTool> {
  return [
    defineTool({
      name: 'get_balances',
      title: 'Get balances',
      description: `Reads the token balances of a multisig account in ${FIAT_CODE}, the ${MAX_BALANCES} largest by fiat value, spam excluded; truncated says when more exist. Prerequisite: chainId from list_chains and the account address. Next: list_queued_transactions for pending transfers, get_safe for owners and threshold.`,
      inputSchema: z.object({
        chainId: NumericStringSchema.describe(
          'Chain id as a decimal string, from list_chains',
        ),
        safeAddress: AddressSchema.describe('Address of the multisig account'),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
      useful: true,
      handler: async ({ chainId, safeAddress }) => {
        const { fiatTotal, items } = await balancesService.getBalances({
          chainId,
          safeAddress,
          fiatCode: FIAT_CODE,
          trusted: true,
          excludeSpam: true,
        });
        const ranked = [...items].sort(
          (a, b) => Number(b.fiatBalance) - Number(a.fiatBalance),
        );
        return {
          fiatCode: FIAT_CODE,
          fiatTotal,
          totalCount: items.length,
          truncated: items.length > MAX_BALANCES,
          results: ranked.slice(0, MAX_BALANCES).map((item) => ({
            type: item.tokenInfo.type,
            address: item.tokenInfo.address,
            name: item.tokenInfo.name,
            symbol: item.tokenInfo.symbol,
            decimals: item.tokenInfo.decimals,
            balance: item.balance,
            fiatBalance: item.fiatBalance,
            fiatConversion: item.fiatConversion,
          })),
        };
      },
    }),
  ];
}
