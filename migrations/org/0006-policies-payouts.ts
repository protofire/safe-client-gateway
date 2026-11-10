import type { MigrationInterface, QueryRunner } from 'typeorm';

const ADMIN_PERMISSIONS = [
  'policies.view',
  'policies.write',
  'payouts.view',
  'payouts.prepare',
  'payouts.manage',
];
const MEMBER_PERMISSIONS = ['policies.view', 'payouts.view', 'payouts.prepare'];

const id = 'id uuid PRIMARY KEY DEFAULT gen_random_uuid()';
const orgId =
  'org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE';
const userRef = 'uuid REFERENCES users(id) ON DELETE SET NULL';
const timestamps = `created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()`;
// same text as 0001: '' after a transaction-local set_config on a pooled connection
const CURRENT_ORG = `NULLIF(current_setting('app.org_id', true), '')::uuid`;
// a pin exists only while the run can still be paid at that nonce
const PINNED = `('draft', 'proposing', 'proposed', 'verifying')`;
// ::text: citext's ~ is case-insensitive
const lowercaseAddress = (column: string): string =>
  `CHECK (${column}::text ~ '^0x[0-9a-f]{40}$')`;
const nonce = (column: string, nullable = false): string =>
  `${column} numeric(78, 0)${nullable ? '' : ' NOT NULL'} CHECK (${column} >= 0)`;
const TWO_TO_256 =
  '115792089237316195423570985008687907853269984665640564039457584007913129639936';

const RLS_TABLES = [
  'policies',
  'policy_versions',
  'policy_findings',
  'payout_runs',
  'payout_items',
  'payout_proposal_attempts',
];

/**
 * Phase 1b: org policies (warn only) and payout runs. Children reference
 * their parent by `(org_id, parent_id)`, so a row can never point at another
 * org's parent. `payout_watch` and `policy_scan_state` are fan-out indexes
 * without RLS (A3 precedent of linked_safes): no money, no names.
 */
export class PoliciesPayouts1794614400000 implements MigrationInterface {
  name = 'PoliciesPayouts1794614400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const sql = (statement: string): Promise<unknown> =>
      queryRunner.query(statement);

    // ADD CONSTRAINT takes an exclusive lock on linked_safes, which live traffic
    // reads: fail fast instead of queueing every reader behind a long transaction.
    // linked_safes is small, so a plain (non-concurrent) build is fine.
    await sql(`SET LOCAL lock_timeout = '5s'`);
    await sql(`SET LOCAL statement_timeout = '60s'`);
    await sql(
      `ALTER TABLE linked_safes ADD CONSTRAINT linked_safes_org_id_id_key UNIQUE (org_id, id)`,
    );

    await sql(`CREATE TABLE policies (
      ${id},
      ${orgId},
      name text NOT NULL,
      status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'deleted')),
      current_version integer NOT NULL DEFAULT 1,
      created_by ${userRef},
      ${timestamps},
      UNIQUE (org_id, id)
    )`);
    await sql(
      `CREATE UNIQUE INDEX policies_org_name_key ON policies (org_id, lower(name)) WHERE status <> 'deleted'`,
    );

    await sql(`CREATE TABLE policy_versions (
      ${id},
      org_id uuid NOT NULL,
      policy_id uuid NOT NULL,
      version integer NOT NULL,
      scope jsonb NOT NULL,
      rules jsonb NOT NULL,
      config_hash text NOT NULL,
      created_by ${userRef},
      ${timestamps},
      UNIQUE (policy_id, version),
      FOREIGN KEY (org_id, policy_id) REFERENCES policies(org_id, id) ON DELETE CASCADE
    )`);

    await sql(`CREATE TABLE policy_findings (
      ${id},
      org_id uuid NOT NULL,
      linked_safe_id uuid NOT NULL,
      chain_id text NOT NULL,
      safe_address citext NOT NULL,
      safe_tx_hash text NOT NULL,
      ${nonce('nonce')},
      evaluation_hash text NOT NULL,
      violations jsonb NOT NULL,
      first_seen_at timestamptz NOT NULL DEFAULT now(),
      last_seen_at timestamptz NOT NULL DEFAULT now(),
      resolved_at timestamptz,
      ${timestamps},
      UNIQUE (org_id, linked_safe_id, safe_tx_hash),
      FOREIGN KEY (org_id, linked_safe_id) REFERENCES linked_safes(org_id, id) ON DELETE CASCADE
    )`);

    // No linked_safe_id: bound to (chain_id, safe_address) so it still settles after an unlink
    await sql(`CREATE TABLE payout_runs (
      ${id},
      ${orgId},
      chain_id text NOT NULL,
      safe_address citext NOT NULL ${lowercaseAddress('safe_address')},
      name text NOT NULL,
      status text NOT NULL DEFAULT 'draft' CHECK (status IN (
        'draft', 'proposing', 'proposed', 'verifying', 'executed',
        'failed', 'replaced', 'rejected', 'needs_review'
      )),
      version integer NOT NULL DEFAULT 1,
      created_by ${userRef},
      calls jsonb,
      est_gas bigint,
      evaluation jsonb,
      ${nonce('pinned_nonce', true)},
      safe_tx_hash text,
      ${nonce('nonce', true)},
      executed_tx_hash text,
      verifying_since timestamptz,
      delay_notified_at timestamptz,
      review jsonb,
      ${timestamps},
      UNIQUE (org_id, id),
      UNIQUE (org_id, safe_tx_hash),
      CONSTRAINT payout_runs_open_needs_pin
        CHECK (status NOT IN ('proposing', 'proposed', 'verifying') OR pinned_nonce IS NOT NULL),
      CONSTRAINT payout_runs_pin_only_while_open
        CHECK (pinned_nonce IS NULL OR status IN ${PINNED})
    )`);
    await sql(
      `CREATE INDEX payout_runs_org_safe_idx ON payout_runs (org_id, chain_id, safe_address)`,
    );
    // backstop for "one open payout per Safe per org" (nonce_taken)
    await sql(
      `CREATE UNIQUE INDEX payout_runs_one_pin_per_safe_key ON payout_runs (org_id, chain_id, safe_address)
       WHERE pinned_nonce IS NOT NULL`,
    );

    // No item status: it is the run's status
    await sql(`CREATE TABLE payout_items (
      ${id},
      org_id uuid NOT NULL,
      run_id uuid NOT NULL,
      line_no integer NOT NULL,
      recipient citext NOT NULL ${lowercaseAddress('recipient')},
      token text NOT NULL CHECK (token = 'native' OR token ~ '^0x[0-9a-f]{40}$'),
      amount text NOT NULL CHECK (length(amount) <= 100),
      amount_raw numeric(78, 0) NOT NULL CHECK (amount_raw > 0 AND amount_raw < ${TWO_TO_256}),
      decimals smallint NOT NULL CHECK (decimals BETWEEN 0 AND 255),
      symbol text NOT NULL,
      name text CHECK (length(name) <= 64),
      warnings text[] NOT NULL DEFAULT '{}',
      ${timestamps},
      FOREIGN KEY (org_id, run_id) REFERENCES payout_runs(org_id, id) ON DELETE CASCADE
    )`);
    await sql(
      `CREATE UNIQUE INDEX payout_items_run_line_key ON payout_items (run_id, line_no)`,
    );

    await sql(`CREATE TABLE payout_proposal_attempts (
      ${id},
      org_id uuid NOT NULL,
      run_id uuid NOT NULL,
      run_version integer NOT NULL,
      ${nonce('nonce')},
      calls jsonb NOT NULL,
      status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reported', 'released')),
      safe_tx_hash text,
      release_reason text CHECK (release_reason IN ('released', 'nonce_used')),
      created_by ${userRef},
      reported_at timestamptz,
      released_at timestamptz,
      released_by ${userRef},
      ${timestamps},
      FOREIGN KEY (org_id, run_id) REFERENCES payout_runs(org_id, id) ON DELETE CASCADE
    )`);
    await sql(
      `CREATE UNIQUE INDEX payout_proposal_attempts_open_key ON payout_proposal_attempts (run_id) WHERE status = 'open'`,
    );
    await sql(
      `CREATE INDEX payout_proposal_attempts_run_id_idx ON payout_proposal_attempts (run_id)`,
    );
    // Attempt history is immutable: the app login may only update the columns
    // in APP_GRANT_EXCEPTIONS (org-migrate.ts), along these transitions.
    await sql(`CREATE FUNCTION payout_attempt_transition() RETURNS trigger
      LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
      BEGIN
        IF NEW.status IS DISTINCT FROM OLD.status AND (OLD.status, NEW.status) NOT IN (
          ('open', 'reported'), ('open', 'released'),
          ('reported', 'released'), ('released', 'reported')
        ) THEN
          RAISE EXCEPTION 'payout proposal attempt transition % -> % not allowed', OLD.status, NEW.status
            USING ERRCODE = 'check_violation', CONSTRAINT = 'payout_attempt_transition';
        END IF;
        RETURN NEW;
      END;
      $$`);
    await sql(`CREATE TRIGGER payout_attempt_transition
      BEFORE UPDATE ON payout_proposal_attempts
      FOR EACH ROW EXECUTE FUNCTION payout_attempt_transition()`);

    for (const table of RLS_TABLES) {
      await sql(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      await sql(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      await sql(`CREATE POLICY ${table}_org_isolation ON ${table} TO PUBLIC
        USING (org_id = ${CURRENT_ORG})
        WITH CHECK (org_id = ${CURRENT_ORG})`);
    }

    // event fan-out: a row exists exactly while its run holds a pin
    await sql(`CREATE TABLE payout_watch (
      run_id uuid PRIMARY KEY,
      org_id uuid NOT NULL,
      chain_id text NOT NULL,
      safe_address citext NOT NULL ${lowercaseAddress('safe_address')},
      FOREIGN KEY (org_id, run_id) REFERENCES payout_runs(org_id, id) ON DELETE CASCADE
    )`);
    await sql(
      `CREATE INDEX payout_watch_chain_address_idx ON payout_watch (chain_id, safe_address)`,
    );

    // queue-walk continuation of the policy scanner
    await sql(`CREATE TABLE policy_scan_state (
      chain_id text NOT NULL,
      address citext NOT NULL,
      next_offset integer NOT NULL DEFAULT 0,
      pass_started_at timestamptz,
      PRIMARY KEY (chain_id, address)
    )`);

    for (const [key, permissions] of [
      ['admin', ADMIN_PERMISSIONS],
      ['member', MEMBER_PERMISSIONS],
    ] as const) {
      await queryRunner.query(
        `UPDATE roles SET permissions = permissions || $1::text[], version = version + 1, updated_at = now()
         WHERE org_id IS NULL AND key = $2`,
        [permissions, key],
      );
    }
    // back to the session values for later migrations in the same transaction
    await sql(`SET LOCAL lock_timeout = DEFAULT`);
    await sql(`SET LOCAL statement_timeout = DEFAULT`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // remove one by one, never overwrite: grants added after 0006 survive
    for (const permission of ADMIN_PERMISSIONS) {
      await queryRunner.query(
        `UPDATE roles SET permissions = array_remove(permissions, $1), version = version + 1, updated_at = now()
         WHERE org_id IS NULL AND $1 = ANY(permissions)`,
        [permission],
      );
    }
    await queryRunner.query(`DROP TABLE IF EXISTS
      policy_scan_state, payout_watch, payout_proposal_attempts, payout_items,
      payout_runs, policy_findings, policy_versions, policies`);
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS payout_attempt_transition()`,
    );
    await queryRunner.query(
      `ALTER TABLE linked_safes DROP CONSTRAINT IF EXISTS linked_safes_org_id_id_key`,
    );
  }
}
