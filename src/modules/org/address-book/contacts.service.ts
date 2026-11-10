import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { getAddress } from 'viem';
import type { EntityManager } from 'typeorm';
import { ActivityLog } from '@/modules/org/activity/activity-log.service';
import {
  type Actor,
  type Contact,
  type ContactInput,
  type ContactPatch,
  MAX_CHAINS,
  MAX_CONTACTS,
} from '@/modules/org/address-book/contacts.schemas';
import { parseSafeAddressBookCsv } from '@/modules/org/address-book/safe-csv.parser';
import { OrgTransaction } from '@/modules/org/db/org-transaction';
import { lockOrgs, recheckPermission } from '@/modules/org/orgs/org-lock';
import { PermissionResolver } from '@/modules/org/permissions/permission.resolver';
import type { Permission } from '@/modules/org/permissions/permissions';

type Row = {
  id: string;
  name: string;
  address: string;
  chain_ids: Array<string>;
  tags: Array<string>;
  version: number;
  created_at: Date;
  updated_at: Date;
};

const COLUMNS = `id, name, address::text AS address, chain_ids, tags, version, created_at, updated_at`;

function toContact(r: Row): Contact {
  return {
    id: r.id,
    name: r.name,
    address: getAddress(r.address),
    chainIds: r.chain_ids,
    tags: r.tags,
    version: r.version,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

const like = (s: string): string => `%${s.replace(/[\\%_]/g, '\\$&')}%`;

@Injectable()
export class ContactsService {
  constructor(
    private readonly tx: OrgTransaction,
    private readonly log: ActivityLog,
    private readonly resolver: PermissionResolver,
  ) {}

  list(
    orgId: string,
    f: { search?: string; tag?: string; chainId?: string },
  ): Promise<Array<Contact>> {
    return this.tx.runInOrgTx(async (em) => {
      const params: Array<unknown> = [orgId];
      const where = ['org_id = $1'];
      if (f.search) {
        params.push(like(f.search));
        where.push(
          `(name ILIKE $${params.length} OR address::text ILIKE $${params.length})`,
        );
      }
      if (f.tag) {
        params.push([f.tag]);
        where.push(`tags @> $${params.length}::text[]`);
      }
      if (f.chainId) {
        params.push([f.chainId]);
        where.push(`chain_ids @> $${params.length}::text[]`);
      }
      const rows: Array<Row> = await em.query(
        `SELECT ${COLUMNS} FROM contacts WHERE ${where.join(' AND ')} ORDER BY name, id`,
        params,
      );
      return rows.map(toContact);
    }, orgId);
  }

  /** Keyset page for the CSV export. */
  page(
    orgId: string,
    after: string | null,
    limit: number,
  ): Promise<Array<Contact>> {
    return this.tx.runInOrgTx(async (em) => {
      const rows: Array<Row> = await em.query(
        `SELECT ${COLUMNS} FROM contacts
          WHERE org_id = $1 AND ($2::uuid IS NULL OR id > $2::uuid)
          ORDER BY id LIMIT $3`,
        [orgId, after, limit],
      );
      return rows.map(toContact);
    }, orgId);
  }

  recordExport(orgId: string, actor: Actor): Promise<void> {
    return this.tx.runInOrgTx(
      (em) =>
        this.log.record(em, {
          orgId,
          actorUserId: actor.userId,
          type: 'export.downloaded',
          payload: { what: 'contacts' },
          ip: actor.ip,
          userAgent: actor.userAgent,
        }),
      orgId,
    );
  }

  create(orgId: string, input: ContactInput, actor: Actor): Promise<Contact> {
    return this.tx.runInOrgTx(async (em) => {
      await this.lockOrg(em, orgId, actor.userId, 'addressbook.write');
      const c = await this.insert(em, orgId, input);
      await this.event(em, orgId, 'contact.created', c, actor);
      return c;
    }, orgId);
  }

  update(
    orgId: string,
    id: string,
    patch: ContactPatch,
    actor: Actor,
  ): Promise<Contact> {
    return this.tx.runInOrgTx(async (em) => {
      await this.lockOrg(em, orgId, actor.userId, 'addressbook.write');
      const c = await this.applyUpdate(em, orgId, id, patch);
      await this.event(em, orgId, 'contact.updated', c, actor);
      return c;
    }, orgId);
  }

  remove(orgId: string, id: string, actor: Actor): Promise<void> {
    return this.tx.runInOrgTx(async (em) => {
      await this.lockOrg(em, orgId, actor.userId, 'addressbook.write');
      const c = await this.applyDelete(em, orgId, id);
      await this.event(em, orgId, 'contact.deleted', c, actor);
    }, orgId);
  }

  async import(
    orgId: string,
    text: string,
    actor: Actor,
  ): Promise<{
    created: number;
    updated: number;
    skipped: Array<{ line: number; reason: string; lines?: Array<number> }>;
  }> {
    const parsed = parseSafeAddressBookCsv(text);
    // Broken quoting shifts or swallows later lines: reject the file, never import part of it
    const malformed = parsed.errors.filter(
      (e) => e.reason === 'unterminated_quote' || e.reason === 'stray_quote',
    );
    if (malformed.length > 0) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        message: 'The CSV has malformed quoting; fix the listed lines',
        code: 'invalid_rows',
        errors: malformed,
      });
    }
    const skipped: Array<{
      line: number;
      reason: string;
      lines?: Array<number>;
    }> = [...parsed.errors];
    // One contact per address: its chains are the union of the CSV rows
    const byAddress = new Map<
      string,
      { name: string; chainIds: Set<string>; lines: Array<number> }
    >();
    for (const r of parsed.rows) {
      const key = r.address.toLowerCase();
      const g = byAddress.get(key) ?? {
        name: r.name,
        chainIds: new Set<string>(),
        lines: [],
      };
      g.name = r.name;
      g.chainIds.add(r.chainId);
      g.lines.push(r.line);
      byAddress.set(key, g);
    }
    return this.tx.runInOrgTx(async (em) => {
      await this.lockOrg(em, orgId, actor.userId, 'addressbook.write');
      const rows: Array<{ id: string; address: string }> = await em.query(
        `SELECT id, address::text AS address FROM contacts WHERE org_id = $1`,
        [orgId],
      );
      const existing = new Map(
        rows.map((r) => [r.address.toLowerCase(), r.id]),
      );
      let count = rows.length;
      let created = 0;
      let updated = 0;
      const over: Array<number> = [];
      let overAddresses = 0;
      for (const [address, g] of byAddress) {
        const chainIds = [...g.chainIds].slice(0, MAX_CHAINS);
        const id = existing.get(address);
        if (id) {
          await em.query(
            `UPDATE contacts SET name = $3,
                    chain_ids = (ARRAY(SELECT x FROM unnest(chain_ids || $4::text[]) x GROUP BY x ORDER BY x::numeric))[1:${MAX_CHAINS}],
                    version = version + 1, updated_at = now()
              WHERE org_id = $1 AND id = $2`,
            [orgId, id, g.name, chainIds],
          );
          updated++;
        } else if (count >= MAX_CONTACTS) {
          overAddresses++;
          over.push(...g.lines);
        } else {
          await em.query(
            `INSERT INTO contacts (org_id, name, address, chain_ids) VALUES ($1, $2, $3, $4)`,
            [orgId, g.name, getAddress(address), chainIds],
          );
          count++;
          created++;
        }
      }
      if (overAddresses > 0) {
        over.sort((a, b) => a - b);
        skipped.push({
          line: over[0],
          lines: over.slice(0, 100),
          reason: `Contact limit (${MAX_CONTACTS}) reached: ${overAddresses} addresses not imported`,
        });
      }
      await this.log.record(em, {
        orgId,
        actorUserId: actor.userId,
        type: 'contact.imported',
        payload: { created, updated },
        ip: actor.ip,
        userAgent: actor.userAgent,
      });
      return { created, updated, skipped };
    }, orgId);
  }

  // ---- building blocks shared with ContactRequestsService (same transaction) ----

  /**
   * First lock of every address-book write (org row before any other row, so
   * there is one global order). Serialises writers per org, so the limit and
   * uniqueness checks cannot race.
   */
  async lockOrg(
    em: EntityManager,
    orgId: string,
    userId: string,
    permission: Permission,
  ): Promise<void> {
    await lockOrgs(em, [orgId]);
    // the guard checked before the lock wait; a concurrent demotion may have happened since
    await recheckPermission(this.resolver, em, orgId, userId, permission);
  }

  async find(em: EntityManager, orgId: string, id: string): Promise<Contact> {
    const [row]: Array<Row> = await em.query(
      `SELECT ${COLUMNS} FROM contacts WHERE org_id = $1 AND id = $2`,
      [orgId, id],
    );
    if (!row) throw new NotFoundException('Contact not found');
    return toContact(row);
  }

  /** Caller holds the org lock. */
  async insert(
    em: EntityManager,
    orgId: string,
    input: ContactInput,
  ): Promise<Contact> {
    if ((await this.count(em, orgId)) >= MAX_CONTACTS) {
      throw new ConflictException({
        statusCode: 409,
        message: `An organization holds at most ${MAX_CONTACTS} contacts`,
        code: 'contact_limit',
      });
    }
    await this.assertAddressFree(em, orgId, input.address, null);
    const [row]: Array<Row> = await this.guardUnique(() =>
      em.query(
        `INSERT INTO contacts (org_id, name, address, chain_ids, tags)
         VALUES ($1, $2, $3, $4, $5) RETURNING ${COLUMNS}`,
        [orgId, input.name, input.address, input.chainIds, input.tags],
      ),
    );
    return toContact(row);
  }

  /** Caller holds the org lock. */
  async applyUpdate(
    em: EntityManager,
    orgId: string,
    id: string,
    patch: ContactPatch,
  ): Promise<Contact> {
    const current = await this.find(em, orgId, id);
    const next = { ...current, ...patch };
    if (patch.address !== undefined) {
      await this.assertAddressFree(em, orgId, next.address, id);
    }
    // TypeORM returns [rows, affected] for UPDATE ... RETURNING
    const [[row]]: Array<[Row | undefined]> = await this.guardUnique(() =>
      em.query(
        `UPDATE contacts SET name = $3, address = $4, chain_ids = $5, tags = $6,
                version = version + 1, updated_at = now()
          WHERE org_id = $1 AND id = $2 RETURNING ${COLUMNS}`,
        [orgId, id, next.name, next.address, next.chainIds, next.tags],
      ),
    );
    if (!row) throw new NotFoundException('Contact not found');
    return toContact(row);
  }

  /** Caller holds the org lock. */
  async applyDelete(
    em: EntityManager,
    orgId: string,
    id: string,
  ): Promise<Contact> {
    const c = await this.find(em, orgId, id);
    await em.query(`DELETE FROM contacts WHERE org_id = $1 AND id = $2`, [
      orgId,
      id,
    ]);
    return c;
  }

  event(
    em: EntityManager,
    orgId: string,
    type: 'contact.created' | 'contact.updated' | 'contact.deleted',
    c: Contact,
    actor: Actor,
  ): Promise<void> {
    return this.log.record(em, {
      orgId,
      actorUserId: actor.userId,
      type,
      targetType: 'contact',
      targetId: c.id,
      payload: { name: c.name, address: c.address },
      ip: actor.ip,
      userAgent: actor.userAgent,
    });
  }

  private async count(em: EntityManager, orgId: string): Promise<number> {
    const [{ n }] = await em.query(
      `SELECT count(*)::int AS n FROM contacts WHERE org_id = $1`,
      [orgId],
    );
    return n;
  }

  private exists(): ConflictException {
    return new ConflictException({
      statusCode: 409,
      message: 'A contact with this address already exists',
      code: 'contact_exists',
    });
  }

  // The unique index (org_id, address) is the backstop for the check below
  private async guardUnique<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw this.exists();
      throw e;
    }
  }

  private async assertAddressFree(
    em: EntityManager,
    orgId: string,
    address: string,
    exceptId: string | null,
  ): Promise<void> {
    const taken = await em.query(
      `SELECT 1 FROM contacts WHERE org_id = $1 AND address = $2 AND ($3::uuid IS NULL OR id <> $3::uuid)`,
      [orgId, address, exceptId],
    );
    if (taken.length > 0) throw this.exists();
  }
}
