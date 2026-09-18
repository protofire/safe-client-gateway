import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { IConfigurationService } from '@/config/configuration.service.interface';
import {
  NetworkService,
  INetworkService,
} from '@/datasources/network/network.service.interface';
import type { Chain } from '@/modules/chains/domain/entities/chain.entity';

export type RelayNativePrice = { usd: number; fetchedAt: number };

/** Relay-only cache: errors never extend the age of the last successful price. */
@Injectable()
export class RelayNativePriceService {
  private readonly prices = new Map<string, RelayNativePrice>();
  private readonly pending = new Map<
    string,
    Promise<RelayNativePrice | null>
  >();
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;

  constructor(
    @Inject(IConfigurationService) configuration: IConfigurationService,
    @Inject(NetworkService) private readonly network: INetworkService,
  ) {
    this.baseUrl = configuration.getOrThrow<string>(
      'balances.providers.safe.prices.baseUri',
    );
    this.apiKey = configuration.get<string>(
      'balances.providers.safe.prices.apiKey',
    );
  }

  async getPrice(chain: Chain): Promise<RelayNativePrice | null> {
    const coin = chain.pricesProvider.nativeCoin;
    if (!coin) return null;
    const cached = this.prices.get(coin);
    if (cached && Date.now() - cached.fetchedAt < 100_000) return cached;
    const pending = this.pending.get(coin);
    if (pending) return pending;
    const request = this.refresh(coin, cached).finally(() =>
      this.pending.delete(coin),
    );
    this.pending.set(coin, request);
    return request;
  }

  private async refresh(
    coin: string,
    cached: RelayNativePrice | undefined,
  ): Promise<RelayNativePrice | null> {
    const fetchedAt = Date.now();
    try {
      const response = await this.network.get({
        url: `${this.baseUrl}/simple/price`,
        networkRequest: {
          params: { ids: coin, vs_currencies: 'usd' },
          ...(this.apiKey && { headers: { 'x-cg-pro-api-key': this.apiKey } }),
        },
      });
      const data = z
        .record(z.string(), z.object({ usd: z.number().positive() }))
        .parse(response.data);
      const usd = data[coin]?.usd;
      if (usd === undefined) throw new Error('Missing native price');
      const price = { usd, fetchedAt };
      this.prices.set(coin, price);
      return price;
    } catch {
      return cached && Date.now() - cached.fetchedAt < 300_000 ? cached : null;
    }
  }
}
