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
import { Clock, type IClock } from '@/modules/org/common/clock';
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

const MAX_RANGE_MS = 366 * 24 * 3600 * 1000;

const EventTypes = z.array(z.enum(ACTIVITY_EVENT_TYPES)).min(1);
const FilterFields = z.object({
  type: z.enum(ACTIVITY_EVENT_TYPES).optional(),
  // `?types=a&types=b` or `?types=a,b`
  types: z
    .preprocess(
      (v) =>
        (Array.isArray(v) ? v : [v])
          .flatMap((s) => (typeof s === 'string' ? s.split(',') : [s]))
          .map((s) => (typeof s === 'string' ? s.trim() : s))
          .filter((s) => s !== ''),
      EventTypes,
    )
    .optional(),
  actor: z.uuid().optional(),
  // inclusive; at most 366 days apart when both are given
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});
const ListFields = FilterFields.extend({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
});

const FilterSchema = FilterFields;
const ListQuerySchema = ListFields;
type Filter = z.infer<typeof FilterSchema>;

/**
 * A range given on one side is closed on the other (to = now, from = to -
 * 366 days), so every dated query spans at most 366 days; 400 otherwise.
 */
function bounded<F extends { from?: string; to?: string }>(
  f: F,
  now: Date,
): F {
  if (f.from === undefined && f.to === undefined) return f;
  const to = f.to ?? now.toISOString();
  const from =
    f.from ?? new Date(Date.parse(to) - MAX_RANGE_MS).toISOString();
  const span = Date.parse(to) - Date.parse(from);
  if (span < 0) throw new BadRequestException('`from` is after `to`');
  if (span > MAX_RANGE_MS) {
    throw new BadRequestException('Range is longer than 366 days');
  }
  return { ...f, from, to };
}

// OpenAPI only: `types` as the array the preprocess accepts
const FilterDoc = FilterFields.extend({ types: EventTypes.optional() });
const ListQueryDoc = ListFields.extend({ types: EventTypes.optional() });

// created_at stays text: JS Dates would drop Postgres' microseconds and make
// the keyset cursor skip or repeat rows
const CursorSchema = z.tuple([z.iso.datetime(), z.uuid()]);
type Cursor = z.infer<typeof CursorSchema>;

type Row = {
  id: string;
  type: string;
  actor_user_id: string | null;
  actor_status: string | null;
  actor_display_name: string | null;
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
    @Inject(Clock) private readonly clock: IClock,
  ) {}

  @Get('activity')
  @OrgApiQuery(ListQueryDoc)
  @RequirePermission('activity.view')
  async list(
    @Req() req: Request,
    @OrgSession() session: OrgSession,
    @Query() query: unknown,
  ): Promise<{ items: Array<unknown>; nextCursor: string | null }> {
    const { cursor, limit, ...rest } = parse(ListQuerySchema, query);
    const filter = bounded(rest, this.clock.now());
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
  @OrgApiQuery(FilterDoc)
  @RequirePermission('exports.read')
  async exportCsv(
    @Req() req: Request,
    @Res() res: Response,
    @OrgSession() session: OrgSession,
    @Query() query: unknown,
  ): Promise<void> {
    const filter = bounded(parse(FilterSchema, query), this.clock.now());
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
    if (filter.types) {
      params.push(filter.types);
      where.push(`e.type = ANY($${params.length}::text[])`);
    }
    if (filter.from) {
      params.push(filter.from);
      where.push(`e.created_at >= $${params.length}::timestamptz`);
    }
    if (filter.to) {
      params.push(filter.to);
      where.push(`e.created_at <= $${params.length}::timestamptz`);
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
              -- shown only while the actor is an active member of this org
              CASE WHEN EXISTS (SELECT 1 FROM members m WHERE m.org_id = e.org_id
                AND m.user_id = e.actor_user_id AND m.status = 'active')
              THEN u.display_name END AS actor_display_name,
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
      // read now, never copied into the event: a rename shows everywhere
      actorDisplayName: deleted ? null : row.actor_display_name,
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
