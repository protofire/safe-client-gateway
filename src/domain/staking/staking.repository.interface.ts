import { Deployment } from '@/datasources/staking-api/entities/deployment.entity';
import { DedicatedStakingStats } from '@/datasources/staking-api/entities/dedicated-staking-stats.entity';
import { NetworkStats } from '@/datasources/staking-api/entities/network-stats.entity';
import { PooledStakingStats } from '@/datasources/staking-api/entities/pooled-staking-stats.entity';
import { DefiVaultStats } from '@/datasources/staking-api/entities/defi-vault-stats.entity';
import { Stake } from '@/datasources/staking-api/entities/stake.entity';

export const IStakingRepository = Symbol('IStakingRepository');

export interface IStakingRepository {
  getDeployment(args: {
    chainId: string;
    address: `0x${string}`;
  }): Promise<Deployment>;

  getNetworkStats(chainId: string): Promise<NetworkStats>;

  getDedicatedStakingStats(chainId: string): Promise<DedicatedStakingStats>;

  getPooledStakingStats(args: {
    chainId: string;
    pool: `0x${string}`;
  }): Promise<PooledStakingStats>;

  getDefiVaultStats(args: {
    chainId: string;
    vault: `0x${string}`;
  }): Promise<DefiVaultStats>;

  getStakes(args: {
    chainId: string;
    safeAddress: `0x${string}`;
    validatorsPublicKeys: Array<`0x${string}`>;
  }): Promise<Stake[]>;

  clearStakes(args: {
    chainId: string;
    safeAddress: `0x${string}`;
  }): Promise<void>;

  clearApi(chainId: string): void;
}
