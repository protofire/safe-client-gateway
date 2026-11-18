import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * UX round: a user's display name, the identity a session signed in with,
 * withdrawn contact requests and a reject reason.
 */
export class UxRound1794700800000 implements MigrationInterface {
  name = 'UxRound1794700800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const sql = (statement: string): Promise<unknown> =>
      queryRunner.query(statement);
    // sessions and users are read on every request: fail fast, as in 0006
    await sql(`SET LOCAL lock_timeout = '5s'`);
    // trimmed, 1-64 characters, no control characters (the API trims first)
    await sql(`ALTER TABLE users ADD COLUMN display_name text
      CONSTRAINT users_display_name_check CHECK (
        length(display_name) BETWEEN 1 AND 64
        AND display_name !~ '^\\s|\\s$'
        AND display_name !~ '[[:cntrl:]]')`);
    await sql(`ALTER TABLE sessions ADD COLUMN identity_id uuid
      REFERENCES identities(id) ON DELETE SET NULL`);
    await sql(
      `CREATE INDEX sessions_identity_id_idx ON sessions (identity_id) WHERE identity_id IS NOT NULL`,
    );
    await sql(
      `ALTER TABLE contact_requests DROP CONSTRAINT contact_requests_status_check`,
    );
    await sql(`ALTER TABLE contact_requests ADD CONSTRAINT contact_requests_status_check
      CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn'))`);
    await sql(`ALTER TABLE contact_requests ADD COLUMN decision_reason text
      CONSTRAINT contact_requests_decision_reason_check CHECK (length(decision_reason) <= 280)`);
    await sql(`SET LOCAL lock_timeout = DEFAULT`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const sql = (statement: string): Promise<unknown> =>
      queryRunner.query(statement);
    await sql(`ALTER TABLE contact_requests DROP COLUMN decision_reason`);
    await sql(
      `UPDATE contact_requests SET status = 'rejected' WHERE status = 'withdrawn'`,
    );
    await sql(
      `ALTER TABLE contact_requests DROP CONSTRAINT contact_requests_status_check`,
    );
    await sql(`ALTER TABLE contact_requests ADD CONSTRAINT contact_requests_status_check
      CHECK (status IN ('pending', 'approved', 'rejected'))`);
    await sql(`ALTER TABLE sessions DROP COLUMN identity_id`);
    await sql(`ALTER TABLE users DROP COLUMN display_name`);
  }
}
