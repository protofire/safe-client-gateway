import type { Chain } from '@/modules/chains/domain/entities/chain.entity';
import type { Page } from '@/domain/entities/page.entity';
import type { SafeApp } from '@/modules/safe-apps/domain/entities/safe-app.entity';
import type { Raw } from '@/validation/entities/raw.entity';
import type { RelayChain } from '@/modules/relay/domain/entities/gas-token.configuration';

export const IConfigApi = Symbol('IConfigApi');

export interface IConfigApi {
  getChains(args: {
    limit?: number;
    offset?: number;
  }): Promise<Raw<Page<Chain>>>;

  getChain(chainId: string): Promise<Raw<Chain>>;

  getRelayChain(chainId: string): Promise<Raw<RelayChain>>;

  clearChain(chainId: string): Promise<void>;

  getSafeApps(args: {
    chainId?: string;
    clientUrl?: string;
    onlyListed?: boolean;
    url?: string;
  }): Promise<Raw<Array<SafeApp>>>;

  clearSafeApps(chainId: string): Promise<void>;
}
