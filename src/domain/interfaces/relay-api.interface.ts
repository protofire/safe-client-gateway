import type { Relay } from '@/modules/relay/domain/entities/relay.entity';
import type { RelayStatus } from '@/modules/relay/domain/entities/relay-status.entity';
import type { Raw } from '@/validation/entities/raw.entity';
import type { Address } from 'viem';

export const IRelayApi = Symbol('IRelayApi');

export interface IRelayApi {
  relay(args: {
    chainId: string;
    to: Address;
    data: string;
    gasLimit: bigint | null;
  }): Promise<Raw<Relay>>;

  getRelayStatus(args: {
    chainId: string;
    taskId: string;
  }): Promise<Raw<RelayStatus>>;

  /** Whether the chain's executor can take a transaction now (not paused, disabled or underfunded). */
  isAvailable(chainId: string): Promise<boolean>;

  /** The executor's gas price ceiling in wei for the chain, or null when it has none. */
  getGasPriceCap(chainId: string): Promise<bigint | null>;

  getRelayCount(args: { chainId: string; address: Address }): Promise<number>;

  setRelayCount(args: {
    chainId: string;
    address: Address;
    count: number;
    ttlSeconds: number;
  }): Promise<void>;
}
