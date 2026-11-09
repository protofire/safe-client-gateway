import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager } from 'typeorm';
import { ORG_DATA_SOURCE } from '@/modules/org/db/org-data-source';

@Injectable()
export class OrgTransaction {
  constructor(
    @InjectDataSource(ORG_DATA_SOURCE) private readonly dataSource: DataSource,
  ) {}

  /**
   * Runs `fn` in one transaction. With `orgId`, sets `app.org_id` for this
   * transaction only, which the RLS policies on contacts/contact_requests read.
   */
  runInOrgTx<T>(
    fn: (em: EntityManager) => Promise<T>,
    orgId?: string,
  ): Promise<T> {
    return this.dataSource.transaction(async (em) => {
      if (orgId !== undefined) {
        await em.query(`SELECT set_config('app.org_id', $1, true)`, [orgId]);
      }
      return fn(em);
    });
  }
}
