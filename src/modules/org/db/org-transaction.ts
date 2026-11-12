import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager } from 'typeorm';
import { ORG_DATA_SOURCE } from '@/modules/org/db/org-data-source';
import { mapLockError } from '@/modules/org/orgs/org-lock';

@Injectable()
export class OrgTransaction {
  constructor(
    @InjectDataSource(ORG_DATA_SOURCE) private readonly dataSource: DataSource,
  ) {}

  /**
   * Runs `fn` in one transaction. With `orgId`, sets `app.org_id` for this
   * transaction only, which the RLS policies on contacts/contact_requests read.
   * Lock deadlocks and timeouts become 409 `retry` (mapLockError).
   */
  runInOrgTx<T>(
    fn: (em: EntityManager) => Promise<T>,
    orgId?: string,
  ): Promise<T> {
    // Pinned, not left to the server default: the last-admin trigger locks the
    // org row and then counts admins, which is only correct when the count
    // sees rows committed while it waited (REPEATABLE READ/SERIALIZABLE would not).
    return this.dataSource
      .transaction('READ COMMITTED', async (em) => {
        if (orgId !== undefined) {
          await em.query(`SELECT set_config('app.org_id', $1, true)`, [orgId]);
        }
        return fn(em);
      })
      .catch(mapLockError);
  }
}
