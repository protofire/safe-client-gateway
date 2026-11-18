import {
  BadRequestException,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import type { Address } from 'viem';
import { IBalancesRepository } from '@/modules/balances/domain/balances.repository.interface';
import { IChainsRepository } from '@/modules/chains/domain/chains.repository.interface';
import { ISafeRepository } from '@/modules/safe/domain/safe.repository.interface';
import { sumDecimals } from '@/modules/org/safes/decimal';
import {
  LinkedSafesService,
  type LinkedSafeRow,
} from '@/modules/org/safes/linked-safes.service';
import { mapLimit, withDeadline } from '@/modules/org/safes/map-limit';
import { readQueue } from '@/modules/org/safes/queue-reader';
import { awaitsSignatureFrom } from '@/modules/org/safes/transactions/row';

// tx-service reads are ~1–2 s each: 12 in flight keeps 50 Safes to a few waves
export const CONCURRENCY = 12;
/** Injectable so tests can shrink the per-Safe deadline. */
export const OVERVIEW_SAFE_TIMEOUT_MS = 'OVERVIEW_SAFE_TIMEOUT_MS';
// ponytail: fixed 8 s per Safe, not configurable; make it config if a chain needs more
export const DEFAULT_SAFE_TIMEOUT_MS = 8_000;

/** A11: at most this many queued transactions are read per Safe. */
export const MAX_QUEUED_PER_SAFE = 100;

export type OverviewSafe = {
  id: string;
  chainId: string;
  address: Address;
  fiatTotal: string;
  queuedCount: number;
  queueTruncated: boolean;
  awaitingMySignature: number;
  /** Read with the balances: fresher than the list's snapshot fallback; absent when unavailable */
  owners?: Array<Address>;
  threshold?: number;
  /** one of my wallets is a live owner */
  iAmSigner?: boolean;
  error?: 'unavailable';
};

export type AwaitingItem = {
  linkedSafeId: string;
  chainId: string;
  safeTxHash: string;
  nonce: number;
  confirmations: number;
  threshold: number;
};

export type Overview = {
  safes: Array<OverviewSafe>;
  totals: { fiatTotal: string; partial: boolean };
  awaitingMySignature: Array<AwaitingItem>;
  complete: boolean;
  unavailableSafeIds: Array<string>;
};

/**
 * Staleness: Safe, balances and queue data come through the gateway
 * repositories' caches under the `org:` prefix. OrgEventsModule clears the
 * repository caches of linked Safes on transaction events; anything else
 * lives for the repositories' TTLs (default 60 s).
 */
@Injectable()
export class OverviewService {
  constructor(
    private readonly linked: LinkedSafesService,
    @Inject(ISafeRepository) private readonly safes: ISafeRepository,
    @Inject(IBalancesRepository)
    private readonly balances: IBalancesRepository,
    @Inject(IChainsRepository) private readonly chains: IChainsRepository,
    @Optional()
    @Inject(OVERVIEW_SAFE_TIMEOUT_MS)
    private readonly safeTimeoutMs: number = DEFAULT_SAFE_TIMEOUT_MS,
  ) {}

  /** `fiat` is case-insensitive: the UI sends the stored lowercase code. */
  async build(orgId: string, userId: string, fiat: string): Promise<Overview> {
    const fiatCode = fiat.toUpperCase();
    // A price-provider outage must not fail the overview: skip the check
    // (balances then come back unavailable, which is reported as partial)
    const supported = await this.balances
      .getFiatCodes()
      .catch((): Array<string> => []);
    if (supported.length > 0 && !supported.includes(fiatCode)) {
      throw new BadRequestException(`Unsupported fiat code: ${fiat}`);
    }
    const [rows, wallets] = await Promise.all([
      this.linked.rows(orgId),
      this.linked.wallets(userId),
    ]);

    const results = await mapLimit(rows, CONCURRENCY, async (row) => {
      try {
        return {
          row,
          ...(await withDeadline(
            this.one(row, fiatCode, wallets),
            this.safeTimeoutMs,
          )),
        };
      } catch {
        return { row, failed: true as const };
      }
    });

    const safes: Array<OverviewSafe> = [];
    const awaiting: Array<AwaitingItem> = [];
    const unavailableSafeIds: Array<string> = [];
    const totals: Array<string> = [];
    for (const r of results) {
      const base = {
        id: r.row.id,
        chainId: r.row.chainId,
        address: r.row.address,
      };
      if ('failed' in r) {
        unavailableSafeIds.push(r.row.id);
        safes.push({
          ...base,
          fiatTotal: '0',
          queuedCount: 0,
          queueTruncated: false,
          awaitingMySignature: 0,
          error: 'unavailable',
        });
        continue;
      }
      totals.push(r.fiatTotal);
      awaiting.push(...r.awaiting);
      safes.push({
        ...base,
        fiatTotal: r.fiatTotal,
        queuedCount: r.queuedCount,
        queueTruncated: r.queueTruncated,
        awaitingMySignature: r.awaiting.length,
        owners: r.owners,
        threshold: r.threshold,
        iAmSigner: r.owners.some((o) => wallets.has(o.toLowerCase())),
      });
    }
    return {
      safes,
      totals: {
        fiatTotal: sumDecimals(totals),
        partial: unavailableSafeIds.length > 0,
      },
      awaitingMySignature: awaiting,
      complete: unavailableSafeIds.length === 0,
      unavailableSafeIds,
    };
  }

  private async one(
    row: LinkedSafeRow,
    fiatCode: string,
    wallets: Set<string>,
  ): Promise<{
    fiatTotal: string;
    queuedCount: number;
    queueTruncated: boolean;
    awaiting: Array<AwaitingItem>;
    owners: Array<Address>;
    threshold: number;
  }> {
    const safe = await this.safes.getSafe({
      chainId: row.chainId,
      address: row.address,
    });
    const [balances, { queued, queueTruncated }] = await Promise.all([
      this.chains.getChain(row.chainId).then((chain) =>
        this.balances.getBalances({
          chain,
          safeAddress: row.address,
          fiatCode,
          trusted: true,
          excludeSpam: true,
        }),
      ),
      readQueue(this.safes, row.chainId, safe, {
        offset: 0,
        max: MAX_QUEUED_PER_SAFE,
      }).then(({ queued, nextOffset }) => ({
        queued,
        queueTruncated: nextOffset !== null,
      })),
    ]);

    const myOwnerAddresses = safe.owners.filter((o) =>
      wallets.has(o.toLowerCase()),
    );
    const awaiting: Array<AwaitingItem> = [];
    if (myOwnerAddresses.length > 0) {
      for (const tx of queued.slice(0, MAX_QUEUED_PER_SAFE)) {
        if (awaitsSignatureFrom(tx, myOwnerAddresses)) {
          awaiting.push({
            linkedSafeId: row.id,
            chainId: row.chainId,
            safeTxHash: tx.safeTxHash,
            nonce: tx.nonce,
            confirmations: tx.confirmations?.length ?? 0,
            threshold: tx.confirmationsRequired,
          });
        }
      }
    }

    return {
      fiatTotal: sumDecimals(
        balances.flatMap((b) => (b.fiatBalance ? [b.fiatBalance] : [])),
      ),
      queuedCount: Math.min(queued.length, MAX_QUEUED_PER_SAFE),
      queueTruncated,
      awaiting,
      owners: safe.owners,
      threshold: safe.threshold,
    };
  }
}
