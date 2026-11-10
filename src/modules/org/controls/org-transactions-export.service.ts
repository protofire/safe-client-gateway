import {
  BadRequestException,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Readable } from 'stream';
import { getAddress, type Address } from 'viem';
import { z } from 'zod';
import {
  type ILoggingService,
  LoggingService,
} from '@/logging/logging.interface';
import { CsvService } from '@/modules/csv-export/csv-utils/csv.service';
import { IExportApiManager } from '@/modules/csv-export/v1/datasources/export-api.manager.interface';
import { CSV_OPTIONS } from '@/modules/csv-export/v1/entities/csv-export.options';
import {
  type TransactionExport,
  TransactionExportPageSchema,
} from '@/modules/csv-export/v1/entities/transaction-export.entity';
import { ActivityLog } from '@/modules/org/activity/activity-log.service';
import { csvCast, limitExports } from '@/modules/org/common/csv';
import { RateLimiter } from '@/modules/org/common/rate-limiter';
import { OrgTransaction } from '@/modules/org/db/org-transaction';
import { parse } from '@/modules/org/orgs/parse';

/** Injectable so tests can shrink the cap. */
export const TX_EXPORT_MAX_ROWS = 'TX_EXPORT_MAX_ROWS';
// shortcut: row cap, move to a job if orgs need more
const DEFAULT_MAX_ROWS = 100_000;
const PAGE_SIZE = 100;
const DAY_MS = 24 * 60 * 60 * 1000;
/** The range must be shorter than this (the UI rejects the same). */
const MAX_RANGE_DAYS = 366;

const DateOrInstant = z.union([z.iso.date(), z.iso.datetime()]);
export const RangeSchema = z.object({
  executedFrom: DateOrInstant,
  executedTo: DateOrInstant,
});

type Linked = { chainId: string; address: Address; label: string };
type Row = Record<string, string>;

const iso = (d: Date | null): string => d?.toISOString() ?? '';

/** Both bounds required; `executedTo` as a plain date includes that whole day. */
function parseRange(query: unknown): { gte: string; lte: string } {
  const { executedFrom, executedTo } = parse(RangeSchema, query);
  const from = Date.parse(executedFrom);
  const to = Date.parse(executedTo);
  if (to < from) {
    throw new BadRequestException('executedTo must not be before executedFrom');
  }
  if ((to - from) / DAY_MS >= MAX_RANGE_DAYS) {
    throw new BadRequestException(
      `The range must be shorter than ${MAX_RANGE_DAYS} days`,
    );
  }
  return {
    gte: new Date(from).toISOString(),
    lte: new Date(
      /^\d{4}-\d{2}-\d{2}$/.test(executedTo) ? to + DAY_MS - 1 : to,
    ).toISOString(),
  };
}

@Injectable()
export class OrgTransactionsExportService {
  constructor(
    private readonly tx: OrgTransaction,
    private readonly log: ActivityLog,
    private readonly csv: CsvService,
    private readonly rateLimiter: RateLimiter,
    @Inject(IExportApiManager)
    private readonly exportApiManager: IExportApiManager,
    @Inject(LoggingService) private readonly logger: ILoggingService,
    @Optional()
    @Inject(TX_EXPORT_MAX_ROWS)
    private readonly maxRows: number = DEFAULT_MAX_ROWS,
  ) {}

  async stream(
    orgId: string,
    query: unknown,
    req: Request,
    res: Response,
    userId: string,
  ): Promise<void> {
    const range = parseRange(query);
    await limitExports(this.rateLimiter, userId);
    // the database part is done before the first tx-service call
    const safes = await this.tx.runInOrgTx(async (em) => {
      const rows: Array<{
        chain_id: string;
        address: string;
        label: string | null;
      }> = await em.query(
        `SELECT chain_id, address, label FROM linked_safes
          WHERE org_id = $1 ORDER BY created_at, id`,
        [orgId],
      );
      await this.log.record(em, {
        orgId,
        actorUserId: userId,
        type: 'export.downloaded',
        payload: { what: 'transactions' },
        ip: req.ip,
        userAgent: req.get('user-agent'),
      });
      return rows.map(
        (r): Linked => ({
          chainId: r.chain_id,
          address: getAddress(r.address),
          label: r.label ?? '',
        }),
      );
    }, orgId);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="transactions.csv"',
    );
    try {
      await this.csv.toCsv(Readable.from(this.rows(safes, range)), res, {
        header: true,
        cast: csvCast,
        columns: [
          { key: 'chainId', header: 'Chain ID' },
          { key: 'safeLabel', header: 'Safe label' },
          ...CSV_OPTIONS.columns,
          { key: 'status', header: 'Status' },
        ],
      });
    } catch (error) {
      // headers are already sent: log and cut the connection so the client sees a truncated download
      this.logger.error(
        `transactions CSV export failed mid-stream: ${error instanceof Error ? error.message : String(error)}`,
      );
      res.destroy();
    }
  }

  /** Safes one after another, 100 per page; a failing Safe becomes one `unavailable` row. */
  private async *rows(
    safes: Array<Linked>,
    range: { gte: string; lte: string },
  ): AsyncGenerator<Row> {
    let count = 0;
    for (const safe of safes) {
      const base = { chainId: safe.chainId, safeLabel: safe.label };
      const before = count;
      try {
        const api = await this.exportApiManager.getApi(safe.chainId);
        for (let offset = 0; ; offset += PAGE_SIZE) {
          const page = TransactionExportPageSchema.parse(
            await api.export({
              safeAddress: safe.address,
              executionDateGte: range.gte,
              executionDateLte: range.lte,
              limit: PAGE_SIZE,
              offset,
            }),
          );
          for (const t of page.results) {
            if (count++ >= this.maxRows) {
              yield { ...base, status: 'truncated' };
              return;
            }
            yield { ...base, ...this.toRow(t), status: 'executed' };
          }
          if (!page.next) break;
        }
      } catch (error) {
        this.logger.error(
          `transactions export failed for ${safe.chainId}:${safe.address}: ${error instanceof Error ? error.message : String(error)}`,
        );
        if (count++ >= this.maxRows) {
          yield { ...base, status: 'truncated' };
          return;
        }
        // rows already written for this Safe: the data is incomplete, not absent
        yield {
          ...base,
          safe: safe.address,
          status: count - 1 > before ? 'partial' : 'unavailable',
        };
      }
    }
  }

  private toRow(t: TransactionExport): Row {
    return {
      nonce: t.nonce ?? '',
      safe: t.safe,
      from: t.from,
      to: t.to,
      transactionHash: t.transactionHash,
      contractAddress: t.contractAddress ?? '',
      amount: t.amount,
      assetType: t.assetType,
      assetSymbol: t.assetSymbol ?? '',
      proposedAt: iso(t.proposedAt),
      executedAt: iso(t.executedAt),
      proposerAddress: t.proposerAddress ?? '',
      executorAddress: t.executorAddress ?? '',
      note: t.note ?? '',
    };
  }
}
