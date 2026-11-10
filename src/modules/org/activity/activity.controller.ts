import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Request, Response } from 'express';
import { Readable } from 'stream';
import { DataSource } from 'typeorm';
import { z } from 'zod';
import {
  type ILoggingService,
  LoggingService,
} from '@/logging/logging.interface';
import { CsvService } from '@/modules/csv-export/csv-utils/csv.service';
import { ACTIVITY_EVENT_TYPES } from '@/modules/org/activity/activity-event-types';
import { ActivityLog } from '@/modules/org/activity/activity-log.service';
import { OrgSession } from '@/modules/org/auth/decorators';
import { csvCast, limitExports } from '@/modules/org/common/csv';
import { RateLimiter } from '@/modules/org/common/rate-limiter';
import { FieldEncryptionService } from '@/modules/org/crypto/field-encryption.service';
import { parse } from '@/modules/org/orgs/parse';
import { ORG_DATA_SOURCE } from '@/modules/org/db/org-data-source';
import { RequirePermission } from '@/modules/org/permissions/require-permission.decorator';
import { OrgApiQuery } from '@/modules/org/common/org-api-body.decorator';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const CSV_PAGE_SIZE = 500;

const FilterSchema = z.object({
  type: z.enum(ACTIVITY_EVENT_TYPES).optional(),
  actor: z.uuid().optional(),
});
const ListQuerySchema = FilterSchema.extend({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
});
type Filter = z.infer<typeof FilterSchema>;

// created_at stays text: JS Dates would drop Postgres' microseconds and make
// the keyset cursor skip or repeat rows
const CursorSchema = z.tuple([z.iso.datetime(), z.uuid()]);
type Cursor = z.infer<typeof CursorSchema>;

type Row = {
  id: string;
  type: string;
  actor_user_id: string | null;
  actor_status: string | null;
  target_type: string | null;
  target_id: string | null;
  payload: Record<string, unknown>;
  ip_encrypted: string | null;
  user_agent: string | null;
  created_at: string;
};

function encodeCursor(row: Row): string {
  return Buffer.from(JSON.stringify([row.created_at, row.id])).toString(
    'base64url',
  );
}

function decodeCursor(raw: string): Cursor {
  try {
    return CursorSchema.parse(
      JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')),
    );
  } catch {
    throw new BadRequestException('Invalid cursor');
  }
}

@Controller({ path: 'orgs/:orgId', version: '1' })
export class ActivityController {
  constructor(
    @InjectDataSource(ORG_DATA_SOURCE) private readonly dataSource: DataSource,
    private readonly encryption: FieldEncryptionService,
    private readonly log: ActivityLog,
    private readonly csv: CsvService,
    private readonly rateLimiter: RateLimiter,
    @Inject(LoggingService) private readonly logger: ILoggingService,
  ) {}

  @Get('activity')
  @OrgApiQuery(ListQuerySchema)
  @RequirePermission('activity.view')
  async list(
    @Req() req: Request,
    @OrgSession() session: OrgSession,
    @Query() query: unknown,
  ): Promise<{ items: Array<unknown>; nextCursor: string | null }> {
    const { cursor, limit, ...filter } = parse(ListQuerySchema, query);
    const orgId = req.params.orgId;
    const rows = await this.page(
      orgId,
      filter,
      cursor ? decodeCursor(cursor) : null,
      limit + 1,
    );
    const items = rows.slice(0, limit);
    const canSeeAll =
      req.orgMember?.permissions.includes('members.remove') ?? false;
    return {
      items: items.map((r) => this.toItem(r, canSeeAll, session.userId)),
      nextCursor:
        rows.length > limit ? encodeCursor(items[items.length - 1]) : null,
    };
  }

  @Get('activity.csv')
  @OrgApiQuery(FilterSchema)
  @RequirePermission('exports.read')
  async exportCsv(
    @Req() req: Request,
    @Res() res: Response,
    @OrgSession() session: OrgSession,
    @Query() query: unknown,
  ): Promise<void> {
    const filter = parse(FilterSchema, query);
    const orgId = req.params.orgId;
    await limitExports(this.rateLimiter, session.userId);
    await this.dataSource.transaction((em) =>
      this.log.record(em, {
        orgId,
        actorUserId: session.userId,
        type: 'export.downloaded',
        payload: { what: 'activity' },
        ip: req.ip,
        userAgent: req.get('user-agent'),
      }),
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="activity.csv"');
    try {
      await this.csv.toCsv(Readable.from(this.csvRows(orgId, filter)), res, {
        header: true,
        cast: csvCast,
        columns: [
          { key: 'createdAt', header: 'createdAt' },
          { key: 'type', header: 'type' },
          { key: 'actorUserId', header: 'actorUserId' },
          { key: 'targetType', header: 'targetType' },
          { key: 'targetId', header: 'targetId' },
          { key: 'payload', header: 'payload' },
        ],
      });
    } catch (error) {
      // headers are already sent: log and cut the connection so the client sees a truncated download
      this.logger.error(
        `activity CSV export failed mid-stream: ${error instanceof Error ? error.message : String(error)}`,
      );
      res.destroy();
    }
  }

  // Keyset pages, so memory stays flat however long the log is
  private async *csvRows(
    orgId: string,
    filter: Filter,
  ): AsyncGenerator<Record<string, string>> {
    let cursor: Cursor | null = null;
    for (;;) {
      const rows = await this.page(orgId, filter, cursor, CSV_PAGE_SIZE);
      for (const r of rows) {
        const deleted = r.actor_status === 'deleted';
        yield {
          createdAt: r.created_at,
          type: r.type,
          actorUserId: deleted ? '' : (r.actor_user_id ?? ''),
          targetType: r.target_type ?? '',
          targetId: r.target_id ?? '',
          payload: JSON.stringify(r.payload),
        };
      }
      if (rows.length < CSV_PAGE_SIZE) return;
      const last = rows[rows.length - 1];
      cursor = [last.created_at, last.id];
    }
  }

  private page(
    orgId: string,
    filter: Filter,
    cursor: Cursor | null,
    limit: number,
  ): Promise<Array<Row>> {
    const params: Array<unknown> = [orgId];
    const where = ['e.org_id = $1'];
    if (filter.type) {
      params.push(filter.type);
      where.push(`e.type = $${params.length}`);
    }
    if (filter.actor) {
      params.push(filter.actor);
      where.push(`e.actor_user_id = $${params.length}`);
      where.push(`u.status <> 'deleted'`);
    }
    if (cursor) {
      params.push(cursor[0], cursor[1]);
      where.push(
        `(e.created_at, e.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
      );
    }
    params.push(limit);
    return this.dataSource.query(
      `SELECT e.id, e.type, e.actor_user_id, u.status AS actor_status,
              e.target_type, e.target_id, e.payload, e.ip_encrypted, e.user_agent,
              to_char(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
         FROM activity_events e
         LEFT JOIN users u ON u.id = e.actor_user_id
        WHERE ${where.join(' AND ')}
        ORDER BY e.created_at DESC, e.id DESC
        LIMIT $${params.length}`,
      params,
    );
  }

  private toItem(row: Row, canSeeAll: boolean, callerId: string): object {
    const deleted = row.actor_status === 'deleted';
    const actorUserId = deleted ? null : row.actor_user_id;
    const showDevice =
      !deleted &&
      (canSeeAll || (actorUserId !== null && actorUserId === callerId));
    return {
      id: row.id,
      type: row.type,
      actorUserId,
      targetType: row.target_type,
      targetId: row.target_id,
      payload: row.payload,
      ...(showDevice && row.ip_encrypted
        ? { ip: this.encryption.decrypt(row.ip_encrypted) }
        : {}),
      ...(showDevice && row.user_agent ? { userAgent: row.user_agent } : {}),
      createdAt: row.created_at,
    };
  }
}
