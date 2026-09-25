import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { getAddress, type Address } from 'viem';
import { z } from 'zod';
import { IConfigurationService } from '@/config/configuration.service.interface';
import {
  NetworkService,
  type INetworkService,
} from '@/datasources/network/network.service.interface';
import { LogType } from '@/domain/common/entities/log-type.entity';
import {
  LoggingService,
  type ILoggingService,
} from '@/logging/logging.interface';

export type SanctionsConfiguration = {
  listUrl: string | undefined;
  maxStalenessHours: number;
  extraAddresses: Array<string>;
};

const SanctionsListSchema = z
  .object({
    schema: z.literal(1),
    sourceSha256: z.string(),
    sourcePublishDate: z.string(),
    generatedAt: z.string(),
    checkedAt: z.string().datetime(),
    count: z.number().int().positive(),
    addresses: z.array(z.string().regex(/^0x[0-9a-f]{40}$/)),
  })
  .refine((list) => list.count === list.addresses.length);

export type SanctionsListVersion = {
  sourceSha256: string;
  sourcePublishDate: string;
  checkedAt: string;
};

export type SanctionsCheck = {
  result: 'clear' | 'hit' | 'unavailable';
  matches: Array<Address>;
  list: SanctionsListVersion | null;
};

const REFRESH_INTERVAL_MS = 15 * 60 * 1000;

@Injectable()
export class SanctionsListService implements OnModuleInit {
  private readonly config: SanctionsConfiguration;
  // Misconfiguration in production must not crash the gateway (RelayModule is
  // imported unconditionally); it fails closed instead: isEnabled() stays true
  // and check() always returns 'unavailable' (503) until fixed.
  private readonly misconfigured: boolean;
  private list: {
    addresses: Set<string>;
    version: SanctionsListVersion;
  } | null = null;

  constructor(
    @Inject(IConfigurationService) configurationService: IConfigurationService,
    @Inject(NetworkService) private readonly networkService: INetworkService,
    @Inject(LoggingService) private readonly loggingService: ILoggingService,
  ) {
    this.config =
      configurationService.getOrThrow<SanctionsConfiguration>(
        'relay.sanctions',
      );
    let misconfigured = false;
    if (configurationService.getOrThrow<boolean>('application.isProduction')) {
      if (!this.config.listUrl) {
        misconfigured = true;
        this.loggingService.error({
          type: LogType.SanctionsListRefreshFailed,
          error: 'SANCTIONS_LIST_URL is required in production',
        });
      }
      if (this.config.extraAddresses.length > 0) {
        misconfigured = true;
        this.loggingService.error({
          type: LogType.SanctionsListRefreshFailed,
          error: 'SANCTIONS_EXTRA_ADDRESSES is not allowed in production',
        });
      }
    }
    this.misconfigured = misconfigured;
    if (
      !Number.isFinite(this.config.maxStalenessHours) ||
      this.config.maxStalenessHours <= 0
    ) {
      throw new Error(
        'SANCTIONS_MAX_STALENESS_HOURS must be a positive number',
      );
    }
  }

  isEnabled(): boolean {
    return this.misconfigured || !!this.config.listUrl;
  }

  async onModuleInit(): Promise<void> {
    await this.refresh();
  }

  @Interval(REFRESH_INTERVAL_MS)
  async refresh(): Promise<void> {
    if (!this.config.listUrl) {
      return;
    }
    try {
      const { data } = await this.networkService.get<unknown>({
        url: this.config.listUrl,
      });
      const parsed = SanctionsListSchema.parse(data);
      this.list = {
        addresses: new Set([
          ...parsed.addresses,
          // Never merge extras when misconfigured (production disallows them)
          ...(this.misconfigured ? [] : this.config.extraAddresses),
        ]),
        version: {
          sourceSha256: parsed.sourceSha256,
          sourcePublishDate: parsed.sourcePublishDate,
          checkedAt: parsed.checkedAt,
        },
      };
    } catch (error) {
      // Keep the last good list; staleness in check() makes a dead source fail closed
      this.loggingService.warn({
        type: LogType.SanctionsListRefreshFailed,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  check(addresses: ReadonlyArray<Address>, now = Date.now()): SanctionsCheck {
    if (this.misconfigured) {
      return { result: 'unavailable', matches: [], list: null };
    }
    const list = this.list;
    const maxAgeMs = this.config.maxStalenessHours * 60 * 60 * 1000;
    if (!list || now - Date.parse(list.version.checkedAt) > maxAgeMs) {
      return {
        result: 'unavailable',
        matches: [],
        list: list?.version ?? null,
      };
    }
    const matches = addresses.filter((address) =>
      list.addresses.has(address.toLowerCase()),
    );
    return {
      result: matches.length > 0 ? 'hit' : 'clear',
      matches: matches.map((address) => getAddress(address)),
      list: list.version,
    };
  }
}
