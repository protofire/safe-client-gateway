import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { z } from 'zod';
import { ActivityLog } from '@/modules/org/activity/activity-log.service';
import { ContactsService } from '@/modules/org/address-book/contacts.service';
import {
  type Actor,
  type Contact,
  ContactPatchSchema,
  ContactSchema,
  type CreateRequestSchema,
  MAX_PENDING_PER_ORG,
  MAX_PENDING_PER_REQUESTER,
} from '@/modules/org/address-book/contacts.schemas';
import { OrgTransaction } from '@/modules/org/db/org-transaction';

type Status = 'pending' | 'approved' | 'rejected';
type CursorKey = [string, string];
type Row = {
  id: string;
  contact_id: string | null;
  contact_version: number | null;
  action: 'create' | 'update' | 'delete';
  payload: Record<string, unknown>;
  requested_by: string | null;
  status: Status;
  decided_by: string | null;
  decided_at: Date | null;
  created_at: Date;
  ts: string;
};
export type ContactRequest = {
  id: string;
  action: Row['action'];
  contactId: string | null;
  payload: Record<string, unknown>;
  requestedBy: string | null;
  status: Status;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
};

const COLUMNS = `id, contact_id, contact_version, action, payload, requested_by, status, decided_by, decided_at, created_at,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ts`;

function toRequest(r: Row): ContactRequest {
  return {
    id: r.id,
    action: r.action,
    contactId: r.contact_id,
    payload: r.payload,
    requestedBy: r.requested_by,
    status: r.status,
    decidedBy: r.decided_by,
    decidedAt: r.decided_at?.toISOString() ?? null,
    createdAt: r.created_at.toISOString(),
  };
}

function decodeCursor(raw: string): CursorKey {
  try {
    return z
      .tuple([z.string().min(1), z.uuid()])
      .parse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
  } catch {
    throw new BadRequestException('Invalid cursor');
  }
}

@Injectable()
export class ContactRequestsService {
  constructor(
    private readonly tx: OrgTransaction,
    private readonly contacts: ContactsService,
    private readonly log: ActivityLog,
  ) {}

  async list(
    orgId: string,
    q: { status: Status | 'all'; cursor?: string; limit: number },
  ): Promise<{ items: Array<ContactRequest>; nextCursor: string | null }> {
    const after = q.cursor ? decodeCursor(q.cursor) : null;
    return this.tx.runInOrgTx(async (em) => {
      // created_at stays text so microseconds survive the keyset cursor
      const rows: Array<Row> = await em.query(
        `SELECT ${COLUMNS} FROM contact_requests
          WHERE org_id = $1 AND ($2::text IS NULL OR status = $2)
            AND ($3::timestamptz IS NULL OR (created_at, id) < ($3::timestamptz, $4::uuid))
          ORDER BY created_at DESC, id DESC LIMIT $5`,
        [
          orgId,
          q.status === 'all' ? null : q.status,
          after?.[0] ?? null,
          after?.[1] ?? null,
          q.limit + 1,
        ],
      );
      const page = rows.slice(0, q.limit);
      const last = page[page.length - 1];
      return {
        items: page.map(toRequest),
        nextCursor:
          rows.length > q.limit
            ? Buffer.from(JSON.stringify([last.ts, last.id])).toString(
                'base64url',
              )
            : null,
      };
    }, orgId);
  }

  create(
    orgId: string,
    input: z.infer<typeof CreateRequestSchema>,
    actor: Actor,
  ): Promise<ContactRequest> {
    return this.tx.runInOrgTx(async (em) => {
      await this.contacts.lockOrg(em, orgId);
      // The FK cannot enforce the org (FKs bypass RLS): look the contact up
      // through the org-scoped query, which answers 404 for another org's id.
      const contactId = input.action === 'create' ? null : input.contactId;
      const existing =
        contactId === null
          ? null
          : await this.contacts.find(em, orgId, contactId);
      const payload = input.action === 'delete' ? {} : input.payload;
      const version = existing?.version ?? null;

      const [same]: Array<Row> = await em.query(
        `SELECT ${COLUMNS} FROM contact_requests
          WHERE org_id = $1 AND status = 'pending' AND action = $2
            AND contact_id IS NOT DISTINCT FROM $3::uuid
            AND contact_version IS NOT DISTINCT FROM $4::int
            AND payload = $5::jsonb
          LIMIT 1`,
        [orgId, input.action, contactId, version, JSON.stringify(payload)],
      );
      if (same) return toRequest(same);

      const [counts]: Array<{ org: number; mine: number }> = await em.query(
        `SELECT count(*)::int AS org, (count(*) FILTER (WHERE requested_by = $2))::int AS mine
           FROM contact_requests WHERE org_id = $1 AND status = 'pending'`,
        [orgId, actor.userId],
      );
      if (
        counts.org >= MAX_PENDING_PER_ORG ||
        counts.mine >= MAX_PENDING_PER_REQUESTER
      ) {
        throw new ConflictException({
          statusCode: 409,
          message: 'Too many pending requests',
          code: 'request_limit',
        });
      }

      const [row]: Array<Row> = await em.query(
        `INSERT INTO contact_requests (org_id, contact_id, contact_version, action, payload, requested_by)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6) RETURNING ${COLUMNS}`,
        [
          orgId,
          contactId,
          version,
          input.action,
          JSON.stringify(payload),
          actor.userId,
        ],
      );
      const shown =
        input.action === 'create'
          ? input.payload
          : {
              ...existing,
              ...(input.action === 'update' ? input.payload : {}),
            };
      await this.event(em, orgId, 'created', row, shown, actor);
      return toRequest(row);
    }, orgId);
  }

  approve(orgId: string, id: string, actor: Actor): Promise<ContactRequest> {
    return this.tx.runInOrgTx(async (em) => {
      await this.contacts.lockOrg(em, orgId);
      const req = await this.lockPending(em, orgId, id);
      let result: Pick<Contact, 'name' | 'address'>;
      if (req.action === 'create') {
        const input = ContactSchema.safeParse(req.payload);
        if (!input.success) throw this.invalid();
        const c = await this.contacts.insert(em, orgId, input.data);
        await this.contacts.event(em, orgId, 'contact.created', c, actor);
        result = c;
      } else {
        // contact_id is SET NULL when the contact was deleted after the request
        if (req.contact_id === null) throw this.gone();
        const current = await this.contacts.find(em, orgId, req.contact_id);
        if (current.version !== req.contact_version) {
          throw new ConflictException({
            statusCode: 409,
            message: 'The contact changed after this request was made',
            code: 'request_stale',
          });
        }
        if (req.action === 'update') {
          const patch = ContactPatchSchema.safeParse(req.payload);
          if (!patch.success) throw this.invalid();
          const c = await this.contacts.applyUpdate(
            em,
            orgId,
            req.contact_id,
            patch.data,
          );
          await this.contacts.event(em, orgId, 'contact.updated', c, actor);
          result = c;
        } else {
          const c = await this.contacts.applyDelete(em, orgId, req.contact_id);
          await this.contacts.event(em, orgId, 'contact.deleted', c, actor);
          result = c;
        }
      }
      const decided = await this.decide(em, orgId, id, 'approved', actor);
      await this.event(em, orgId, 'approved', decided, result, actor);
      return toRequest(decided);
    }, orgId);
  }

  reject(orgId: string, id: string, actor: Actor): Promise<ContactRequest> {
    return this.tx.runInOrgTx(async (em) => {
      await this.contacts.lockOrg(em, orgId);
      const req = await this.lockPending(em, orgId, id);
      let subject: { name?: string; address?: string } = req.payload;
      if (req.action !== 'create') {
        subject =
          req.contact_id === null
            ? {}
            : await this.contacts.find(em, orgId, req.contact_id);
      }
      const decided = await this.decide(em, orgId, id, 'rejected', actor);
      await this.event(em, orgId, 'rejected', decided, subject, actor);
      return toRequest(decided);
    }, orgId);
  }

  private invalid(): ConflictException {
    return new ConflictException({
      statusCode: 409,
      message: 'The stored request is no longer valid',
      code: 'request_invalid',
    });
  }

  private gone(): ConflictException {
    return new ConflictException({
      statusCode: 409,
      message: 'The contact no longer exists',
      code: 'contact_gone',
    });
  }

  private async lockPending(
    em: EntityManager,
    orgId: string,
    id: string,
  ): Promise<Row> {
    const [row]: Array<Row> = await em.query(
      `SELECT ${COLUMNS} FROM contact_requests WHERE org_id = $1 AND id = $2 FOR UPDATE`,
      [orgId, id],
    );
    if (!row) throw new NotFoundException('Request not found');
    if (row.status !== 'pending') {
      throw new ConflictException({
        statusCode: 409,
        message: `Request already ${row.status}`,
        code: 'request_decided',
      });
    }
    return row;
  }

  private async decide(
    em: EntityManager,
    orgId: string,
    id: string,
    status: 'approved' | 'rejected',
    actor: Actor,
  ): Promise<Row> {
    // TypeORM returns [rows, affected] for UPDATE ... RETURNING
    const [[row]]: Array<[Row]> = await em.query(
      `UPDATE contact_requests SET status = $3, decided_by = $4, decided_at = now(), updated_at = now()
        WHERE org_id = $1 AND id = $2 RETURNING ${COLUMNS}`,
      [orgId, id, status, actor.userId],
    );
    return row;
  }

  private event(
    em: EntityManager,
    orgId: string,
    kind: 'created' | 'approved' | 'rejected',
    req: Row,
    subject: { name?: string; address?: string },
    actor: Actor,
  ): Promise<void> {
    return this.log.record(em, {
      orgId,
      actorUserId: actor.userId,
      type: `contact_request.${kind}`,
      targetType: 'contact_request',
      targetId: req.id,
      payload: {
        name: subject.name ?? '',
        address: subject.address ?? '',
        action: req.action,
      },
      ip: actor.ip,
      userAgent: actor.userAgent,
    });
  }
}
