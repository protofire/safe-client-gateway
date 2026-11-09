import {
  BadRequestException,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import type { Address } from 'viem';
import { IBalancesRepository } from '@/modules/balances/domain/balances.repository.interface';
import { IChainsRepository } from '@/modules/chains/domain/chains.repository.interface';
import type { MultisigTransaction } from '@/modules/safe/domain/entities/multisig-transaction.entity';
import type { Safe } from '@/modules/safe/domain/entities/safe.entity';
import { ISafeRepository } from '@/modules/safe/domain/safe.repository.interface';
import { sumDecimals } from '@/modules/org/safes/decimal';
import {
  LinkedSafesService,
  type LinkedSafeRow,
} from '@/modules/org/safes/linked-safes.service';
import { mapLimit } from '@/modules/org/safes/map-limit';

const CONCURRENCY = 5;
/** Injectable so tests can shrink the per-Safe deadline. */
export const OVERVIEW_SAFE_TIMEOUT_MS = 'OVERVIEW_SAFE_TIMEOUT_MS';
// ponytail: fixed 8 s per Safe, not configurable; make it config if a chain needs more
const DEFAULT_SAFE_TIMEOUT_MS = 8_000;

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Safe deadline exceeded')), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}
const QUEUE_PAGE_SIZE = 20;
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
 * repositories' caches, and the gateway's webhook invalidation does not reach
 * the `org:` cache prefix. Values can be as old as those repositories' TTLs
 * until Task 11 adds org-side invalidation.
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
      this.walkQueue(row.chainId, safe),
    ]);

    const myOwnerAddresses = safe.owners.filter((o) =>
      wallets.has(o.toLowerCase()),
    );
    const awaiting: Array<AwaitingItem> = [];
    if (myOwnerAddresses.length > 0) {
      for (const tx of queued.slice(0, MAX_QUEUED_PER_SAFE)) {
        const signed = new Set(
          (tx.confirmations ?? []).map((c) => c.owner.toLowerCase()),
        );
        // already executable: nothing left to sign
        if ((tx.confirmations?.length ?? 0) >= tx.confirmationsRequired) {
          continue;
        }
        // an owner wallet of mine that has not confirmed yet
        if (myOwnerAddresses.some((o) => !signed.has(o.toLowerCase()))) {
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
    };
  }

  private async walkQueue(
    chainId: string,
    safe: Safe,
  ): Promise<{ queued: Array<MultisigTransaction>; queueTruncated: boolean }> {
    const queued: Array<MultisigTransaction> = [];
    let queueTruncated = false;
    for (let offset = 0; queued.length < MAX_QUEUED_PER_SAFE; ) {
      const page = await this.safes.getTransactionQueue({
        chainId,
        safe,
        limit: QUEUE_PAGE_SIZE,
        offset,
      });
      queued.push(...page.results);
      offset += QUEUE_PAGE_SIZE;
      if (page.next === null || page.results.length === 0) break;
      if (queued.length >= MAX_QUEUED_PER_SAFE) queueTruncated = true;
    }
    return { queued, queueTruncated };
  }
}
