import {
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { IChainsRepository } from '@/modules/chains/domain/chains.repository.interface';
import { IDataDecoderRepository } from '@/modules/data-decoder/domain/v2/data-decoder.repository.interface';
import type { MultisigTransaction } from '@/modules/safe/domain/entities/multisig-transaction.entity';
import type { Safe } from '@/modules/safe/domain/entities/safe.entity';
import { ISafeRepository } from '@/modules/safe/domain/safe.repository.interface';
import type { Transaction } from '@/modules/transactions/routes/entities/transaction.entity';
import { MultisigTransactionMapper } from '@/modules/transactions/routes/mappers/multisig-transactions/multisig-transaction.mapper';
import {
  LinkedSafesService,
  type LinkedSafeRow,
} from '@/modules/org/safes/linked-safes.service';
import { mapLimit, withDeadline } from '@/modules/org/safes/map-limit';
import { CONCURRENCY } from '@/modules/org/safes/overview.service';
import {
  decodeCursor,
  encodeCursor,
  HistoryKeySchema,
  QueueKeySchema,
  scopeHash,
} from '@/modules/org/safes/transactions/cursor';
import {
  historyPage,
  historyWindow,
  type HistoryReader,
} from '@/modules/org/safes/transactions/history-merge';
import {
  queuePage,
  queueSafeRows,
  type Counts,
  type QueueSafeRead,
} from '@/modules/org/safes/transactions/queue-page';
import {
  multisigId,
  rowKey,
  type MultisigRow,
} from '@/modules/org/safes/transactions/row';
import type { Kind } from '@/modules/org/safes/transactions/tx-kind';

/** Injectable so tests can shrink the History window (spec §9: W = 2). */
export const TRANSACTIONS_WINDOW = 'TRANSACTIONS_WINDOW';
/** Injectable so tests can shrink the request budget and deadlines. */
export const TRANSACTIONS_BUDGET = 'TRANSACTIONS_BUDGET';
export type TransactionsBudget = {
  /** whole request */
  totalMs: number;
  /** per Safe in the fan-out */
  safeMs: number;
  /** kept for mapping: no Safe read starts inside it */
  mappingReserveMs: number;
};
// spec §5 Budget
const DEFAULT_BUDGET: TransactionsBudget = {
  totalMs: 15_000,
  safeMs: 8_000,
  mappingReserveMs: 3_000,
};
const MAPPING_CONCURRENCY = 10;

/** Rows to read, and rows whose chain could not be resolved. */
type Scope = {
  safes: Array<LinkedSafeRow>;
  unknown: Array<LinkedSafeRow>;
};

export type ScopeQuery = {
  linkedSafeId?: Array<string>;
  chainId?: Array<string>;
};
export type ListQuery = ScopeQuery & {
  tab: 'queue' | 'history';
  mine?: boolean;
  kind?: Array<Kind>;
  limit: number;
  cursor?: string;
};
export type ListResponse = {
  items: Array<MultisigRow>;
  nextCursor: string | null;
  searchedUntil: string | null;
  counts: Counts | null;
  complete: boolean;
  unavailableSafeIds: Array<string>;
  truncatedSafeIds: Array<string>;
};

/** What the mapping phase needs per row, keyed by `rowKey`. */
type Source = { tx: MultisigTransaction; safe?: Safe };

/**
 * Spec 027 §5: the org Transactions list and queue counts over the linked
 * Safes in scope, under one request budget. Partial results, never a 5xx
 * for an unreadable Safe.
 */
@Injectable()
export class OrgTransactionsService {
  private readonly budget: TransactionsBudget;

  constructor(
    private readonly linked: LinkedSafesService,
    @Inject(ISafeRepository) private readonly safes: ISafeRepository,
    @Inject(IChainsRepository) private readonly chains: IChainsRepository,
    @Inject(IDataDecoderRepository)
    private readonly decoder: IDataDecoderRepository,
    private readonly mapper: MultisigTransactionMapper,
    @Optional()
    @Inject(TRANSACTIONS_WINDOW)
    private readonly window?: number,
    @Optional()
    @Inject(TRANSACTIONS_BUDGET)
    budget?: Partial<TransactionsBudget>,
  ) {
    this.budget = { ...DEFAULT_BUDGET, ...budget };
  }

  async counts(orgId: string, userId: string, q: ScopeQuery): Promise<Counts> {
    const budgetEnd = Date.now() + this.budget.totalMs;
    const [{ safes, unknown }, wallets] = await Promise.all([
      this.scope(orgId, q, budgetEnd),
      this.linked.wallets(userId),
    ]);
    const { reads } = await this.queueReads(safes, unknown, wallets, budgetEnd);
    return queuePage(reads, { limit: Number.MAX_SAFE_INTEGER, after: null })
      .counts;
  }

  async list(
    orgId: string,
    userId: string,
    q: ListQuery,
  ): Promise<ListResponse> {
    const budgetEnd = Date.now() + this.budget.totalMs;
    const [{ safes, unknown }, wallets] = await Promise.all([
      this.scope(orgId, q, budgetEnd),
      this.linked.wallets(userId),
    ]);
    const s = scopeHash({
      tab: q.tab,
      mine: q.mine,
      kind: q.kind,
      linkedSafeId: q.linkedSafeId,
      chainId: q.chainId,
      scopeSafeIds: [...safes, ...unknown].map((r) => r.id),
    });

    if (q.tab === 'queue') {
      const after = q.cursor ? decodeCursor(q.cursor, s, QueueKeySchema) : null;
      const { reads, sources } = await this.queueReads(
        safes,
        unknown,
        wallets,
        budgetEnd,
      );
      const page = queuePage(reads, {
        kind: q.kind,
        mine: q.mine,
        limit: q.limit,
        after,
      });
      return {
        items: await this.mapRows(page.items, sources, budgetEnd),
        nextCursor: page.nextKey ? encodeCursor(page.nextKey, s) : null,
        searchedUntil: null,
        counts: page.counts,
        complete: page.complete,
        unavailableSafeIds: page.unavailableSafeIds,
        truncatedSafeIds: page.truncatedSafeIds,
      };
    }

    const after = q.cursor ? decodeCursor(q.cursor, s, HistoryKeySchema) : null;
    const sources = new Map<string, Source>();
    const read: HistoryReader = async (safe, hq) => {
      const page = await this.underSafeDeadline(budgetEnd, () =>
        this.safes.getMultisigTransactions({
          chainId: safe.chainId,
          safeAddress: safe.address,
          executed: true,
          ...hq,
        }),
      );
      for (const tx of page.results) {
        sources.set(rowKey(safe.id, multisigId(tx)), { tx });
      }
      return page;
    };
    const page = await historyPage({
      safes,
      read,
      after,
      limit: q.limit,
      kind: q.kind,
      window: this.window ?? historyWindow(q.kind),
    });
    const unavailable = [
      ...page.unavailableSafeIds,
      ...unknown.map((r) => r.id),
    ];
    return {
      items: await this.mapRows(page.items, sources, budgetEnd),
      nextCursor: page.nextKey ? encodeCursor(page.nextKey, s) : null,
      searchedUntil: page.searchedUntil,
      counts: null,
      complete: unavailable.length === 0,
      unavailableSafeIds: unavailable,
      truncatedSafeIds: [],
    };
  }

  /**
   * Linked Safes of the org narrowed by `linkedSafeId`, then by `chainId` or
   * the Safes-page network default: testnets out unless every Safe of the org
   * is on one. A chain whose config cannot be read is neither: its Safes in
   * scope come back as `unknown` (unavailable, never read).
   */
  private async scope(
    orgId: string,
    q: ScopeQuery,
    budgetEnd: number,
  ): Promise<Scope> {
    // the tenant boundary: the org's rows are read under its RLS context
    const rows = await this.linked.rows(orgId);
    const ids = new Set(rows.map((r) => r.id));
    if (q.linkedSafeId?.some((id) => !ids.has(id))) {
      throw new NotFoundException();
    }
    const picked = q.linkedSafeId?.length
      ? rows.filter((r) => q.linkedSafeId!.includes(r.id))
      : rows;
    if (q.chainId?.length) {
      return {
        safes: picked.filter((r) => q.chainId!.includes(r.chainId)),
        unknown: [],
      };
    }
    const chainIds = [...new Set(rows.map((r) => r.chainId))];
    const testnet = new Map(
      await Promise.all(
        chainIds.map(async (chainId) => {
          const isTestnet = await withDeadline(
            this.chains.getChain(chainId),
            Math.max(1, Math.min(this.budget.safeMs, budgetEnd - Date.now())),
          ).then(
            (chain) => chain.isTestnet,
            () => null,
          );
          return [chainId, isTestnet] as const;
        }),
      ),
    );
    const known = rows.filter((r) => testnet.get(r.chainId) !== null);
    const onlyTestnets = known.every((r) => testnet.get(r.chainId) === true);
    return {
      safes: picked.filter(
        (r) =>
          testnet.get(r.chainId) !== null &&
          (onlyTestnets || testnet.get(r.chainId) === false),
      ),
      unknown: picked.filter((r) => testnet.get(r.chainId) === null),
    };
  }

  /** Spec §5 fan-out: `getSafe`, then the newest 100 queued by submission. */
  private async queueReads(
    safes: ReadonlyArray<LinkedSafeRow>,
    unknown: ReadonlyArray<LinkedSafeRow>,
    wallets: ReadonlySet<string>,
    budgetEnd: number,
  ): Promise<{
    reads: Array<QueueSafeRead>;
    sources: Map<string, Source>;
  }> {
    const sources = new Map<string, Source>();
    const reads = await mapLimit(
      safes,
      CONCURRENCY,
      async (row): Promise<QueueSafeRead> => {
        try {
          const { safe, page } = await this.underSafeDeadline(
            budgetEnd,
            async () => {
              const safe = await this.safes.getSafe({
                chainId: row.chainId,
                address: row.address,
              });
              const page = await this.safes.getTransactionQueueBySubmission({
                chainId: row.chainId,
                safe,
              });
              return { safe, page };
            },
          );
          for (const tx of page.results) {
            sources.set(rowKey(row.id, multisigId(tx)), { tx, safe });
          }
          return {
            safe: row,
            ...queueSafeRows(row, safe.owners, page, wallets),
          };
        } catch {
          return { safe: row, failed: true };
        }
      },
    );
    return {
      reads: [
        ...reads,
        ...unknown.map((safe): QueueSafeRead => ({ safe, failed: true })),
      ],
      sources,
    };
  }

  /**
   * A Safe read under `min(safeMs, budgetEnd - reserve - now)`; none starts
   * once the mapping reserve is reached (it then counts as failed).
   */
  private underSafeDeadline<T>(
    budgetEnd: number,
    work: () => Promise<T>,
  ): Promise<T> {
    const left = budgetEnd - this.budget.mappingReserveMs - Date.now();
    if (left <= 0) return Promise.reject(new Error('Request budget spent'));
    return withDeadline(work(), Math.min(this.budget.safeMs, left));
  }

  /**
   * Spec §5 mapping phase: only the emitted rows, each under the rest of the
   * budget. Any throw or timeout keeps the raw row with `transaction: null`.
   */
  private mapRows(
    rows: Array<MultisigRow>,
    sources: Map<string, Source>,
    budgetEnd: number,
  ): Promise<Array<MultisigRow>> {
    const safeOf = new Map<string, Promise<Safe>>();
    const liveSafe = (row: MultisigRow): Promise<Safe> => {
      let safe = safeOf.get(row.linkedSafeId);
      if (!safe) {
        safe = this.safes.getSafe({
          chainId: row.chainId,
          address: row.safeAddress,
        });
        safeOf.set(row.linkedSafeId, safe);
      }
      return safe;
    };
    return mapLimit(rows, MAPPING_CONCURRENCY, async (row) => {
      const source = sources.get(rowKey(row.linkedSafeId, row.id));
      const left = budgetEnd - Date.now();
      if (!source || left <= 0) return row;
      try {
        const transaction = await withDeadline(
          this.mapOne(row.chainId, source, () => liveSafe(row)),
          left,
        );
        return { ...row, transaction };
      } catch {
        return row;
      }
    });
  }

  /** Mirrors the gateway's own multisig list: decode, then map. */
  private async mapOne(
    chainId: string,
    source: Source,
    liveSafe: () => Promise<Safe>,
  ): Promise<Transaction> {
    const [safe, dataDecoded] = await Promise.all([
      source.safe ?? liveSafe(),
      this.decoder.getTransactionDataDecoded({
        chainId,
        transaction: source.tx,
      }),
    ]);
    return this.mapper.mapTransaction(chainId, source.tx, safe, dataDecoded);
  }
}
