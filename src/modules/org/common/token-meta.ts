import { getAddress, type Address } from 'viem';
import { z } from 'zod';
import { DataSourceError } from '@/domain/errors/data-source.error';
import type { ITransactionApiManager } from '@/domain/interfaces/transaction-api.manager.interface';
import type { IChainsRepository } from '@/modules/chains/domain/chains.repository.interface';

export type TokenMeta =
  | { decimals: number; symbol: string }
  | 'unknown'
  | 'not_erc20'
  | 'decimals_unknown';

const MAX_SYMBOL = 32;
// ERC20 decimals is a uint8
const DecimalsSchema = z.number().int().min(0).max(255);
// only what amounts need from the raw tx-service token (the gateway schema turns absent decimals into 0)
const RawTokenSchema = z.object({
  type: z.string(),
  symbol: z.string(),
  decimals: z.unknown(),
});

/** Upstream text shown in the org UI and CSV exports: no control/format characters (bidi tricks), bounded. */
function cleanSymbol(symbol: string): string {
  return symbol.replace(/[\p{Cc}\p{Cf}]/gu, '').slice(0, MAX_SYMBOL);
}

function meta(decimals: unknown, symbol: string): TokenMeta {
  const d = DecimalsSchema.safeParse(decimals);
  // never guess decimals: a wrong value scales every amount
  if (!d.success) return 'decimals_unknown';
  return { decimals: d.data, symbol: cleanSymbol(symbol) };
}

/**
 * Decimals and symbol of a token on a chain (`native` from the chain config,
 * ERC20 from the raw tx-service token). 404 → `unknown`; any other read error
 * is rethrown for the caller to map. HTTP: never call inside a DB transaction.
 */
export async function tokenMeta(
  deps: {
    chains: Pick<IChainsRepository, 'getChain'>;
    transactionApis: Pick<ITransactionApiManager, 'getApi'>;
  },
  chainId: string,
  token: Address | 'native',
): Promise<TokenMeta> {
  try {
    if (token === 'native') {
      const { nativeCurrency } = await deps.chains.getChain(chainId);
      return meta(nativeCurrency.decimals, nativeCurrency.symbol);
    }
    const api = await deps.transactionApis.getApi(chainId);
    const t = RawTokenSchema.parse(await api.getToken(getAddress(token)));
    if (t.type !== 'ERC20') return 'not_erc20';
    return meta(t.decimals, t.symbol);
  } catch (error) {
    if (error instanceof DataSourceError && error.code === 404) {
      return 'unknown';
    }
    throw error;
  }
}
