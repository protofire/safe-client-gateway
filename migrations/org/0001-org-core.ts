import type { MigrationInterface, QueryRunner } from 'typeorm';

const ADMIN_PERMISSIONS = [
  'org.view',
  'org.update',
  'org.delete',
  'members.view',
  'members.invite',
  'members.remove',
  'roles.assign',
  'factors.reset',
  'safes.view',
  'safes.link',
  'safes.unlink',
  'addressbook.view',
  'addressbook.write',
  'addressbook.request',
  'addressbook.review',
  'activity.view',
  'exports.read',
];
const MEMBER_PERMISSIONS = [
  'org.view',
  'members.view',
  'safes.view',
  'addressbook.view',
  'addressbook.request',
  'activity.view',
  'exports.read',
];

const id = 'id uuid PRIMARY KEY DEFAULT gen_random_uuid()';
const timestamps = `created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()`;
// '' after a transaction-local set_config ends on a pooled connection
const CURRENT_ORG = `NULLIF(current_setting('app.org_id', true), '')::uuid`;

export class OrgCore1794182400000 implements MigrationInterface {
  name = 'OrgCore1794182400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const sql = (statement: string): Promise<unknown> =>
      queryRunner.query(statement);

    await sql(`CREATE EXTENSION IF NOT EXISTS citext`);
    // The app login gets DML only; nobody but the owner creates objects
    await sql(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);

    await sql(`CREATE TABLE users (
      ${id},
      status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleted')),
      deleted_at timestamptz,
      ${timestamps}
    )`);

    await sql(`CREATE TABLE identities (
      ${id},
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind text NOT NULL CHECK (kind IN ('wallet', 'oidc')),
      wallet_address citext,
      oidc_issuer text,
      oidc_subject text,
      email_encrypted text,
      -- HMAC-SHA256 with ORG_EMAIL_HASH_KEY, never a plain hash
      email_hash text,
      ${timestamps},
      CHECK (
        (kind = 'wallet' AND wallet_address IS NOT NULL AND oidc_issuer IS NULL AND oidc_subject IS NULL)
        OR (kind = 'oidc' AND wallet_address IS NULL AND oidc_issuer IS NOT NULL AND oidc_subject IS NOT NULL)
      ),
      UNIQUE (oidc_issuer, oidc_subject)
    )`);
    await sql(
      `CREATE UNIQUE INDEX identities_wallet_address_key ON identities (wallet_address) WHERE kind = 'wallet'`,
    );
    await sql(`CREATE INDEX identities_user_id_idx ON identities (user_id)`);
    await sql(
      `CREATE INDEX identities_email_hash_idx ON identities (email_hash)`,
    );

    await sql(`CREATE TABLE sessions (
      ${id},
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash text NOT NULL UNIQUE,
      amr text[] NOT NULL DEFAULT '{}',
      last_strong_auth_at timestamptz,
      expires_at timestamptz NOT NULL,
      idle_expires_at timestamptz NOT NULL,
      revoked_at timestamptz,
      ip_encrypted text,
      user_agent text,
      ${timestamps}
    )`);
    await sql(`CREATE INDEX sessions_user_id_idx ON sessions (user_id)`);

    await sql(`CREATE TABLE factors (
      ${id},
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind text NOT NULL CHECK (kind IN ('totp')),
      secret_encrypted text NOT NULL,
      confirmed_at timestamptz,
      last_used_step bigint,
      ${timestamps}
    )`);
    await sql(`CREATE INDEX factors_user_id_idx ON factors (user_id)`);

    await sql(`CREATE TABLE recovery_codes (
      ${id},
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_hash text NOT NULL,
      used_at timestamptz,
      ${timestamps},
      UNIQUE (user_id, code_hash)
    )`);

    await sql(`CREATE TABLE organizations (
      ${id},
      name text NOT NULL,
      status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleted')),
      deleted_at timestamptz,
      purge_after timestamptz,
      ${timestamps}
    )`);
    await sql(
      `CREATE INDEX organizations_purge_idx ON organizations (purge_after) WHERE status = 'deleted'`,
    );

    await sql(`CREATE TABLE roles (
      ${id},
      org_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
      key text NOT NULL,
      name text NOT NULL,
      permissions text[] NOT NULL,
      version integer NOT NULL DEFAULT 1,
      ${timestamps},
      UNIQUE (org_id, key)
    )`);
    // UNIQUE (org_id, key) does not cover system roles: NULLs are distinct
    await sql(
      `CREATE UNIQUE INDEX roles_system_key ON roles (key) WHERE org_id IS NULL`,
    );

    await sql(`CREATE TABLE members (
      ${id},
      org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id uuid REFERENCES users(id) ON DELETE CASCADE,
      status text NOT NULL CHECK (status IN ('invited', 'active', 'declined')),
      ${timestamps},
      UNIQUE (org_id, user_id)
    )`);
    await sql(`CREATE INDEX members_user_id_idx ON members (user_id)`);

    await sql(`CREATE TABLE role_bindings (
      ${id},
      member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      role_id uuid NOT NULL REFERENCES roles(id),
      scope text NOT NULL DEFAULT 'org',
      ${timestamps},
      UNIQUE (member_id, role_id, scope)
    )`);
    await sql(
      `CREATE INDEX role_bindings_role_id_idx ON role_bindings (role_id)`,
    );

    await sql(`CREATE TABLE invitations (
      ${id},
      org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      target_kind text NOT NULL CHECK (target_kind IN ('wallet', 'email')),
      target_wallet citext,
      -- HMAC-SHA256 with ORG_EMAIL_HASH_KEY, never a plain hash
      target_email_hash text,
      token_hash text NOT NULL UNIQUE,
      invited_by uuid REFERENCES users(id) ON DELETE SET NULL,
      expires_at timestamptz NOT NULL,
      accepted_at timestamptz,
      declined_at timestamptz,
      ${timestamps},
      CHECK (
        (target_kind = 'wallet' AND target_wallet IS NOT NULL AND target_email_hash IS NULL)
        OR (target_kind = 'email' AND target_email_hash IS NOT NULL AND target_wallet IS NULL)
      )
    )`);
    await sql(`CREATE INDEX invitations_org_id_idx ON invitations (org_id)`);
    await sql(
      `CREATE INDEX invitations_member_id_idx ON invitations (member_id)`,
    );

    await sql(`CREATE TABLE linked_safes (
      ${id},
      org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      chain_id text NOT NULL,
      address citext NOT NULL,
      label text,
      ${timestamps},
      UNIQUE (org_id, chain_id, address)
    )`);
    // event fan-out: which orgs link this Safe
    await sql(
      `CREATE INDEX linked_safes_chain_address_idx ON linked_safes (chain_id, address)`,
    );

    await sql(`CREATE TABLE linked_safe_snapshots (
      chain_id text NOT NULL,
      address citext NOT NULL,
      owners text[] NOT NULL,
      threshold integer NOT NULL,
      modules text[] NOT NULL,
      guard citext,
      version text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (chain_id, address)
    )`);

    await sql(`CREATE TABLE contacts (
      ${id},
      org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      name text NOT NULL,
      address citext NOT NULL,
      chain_ids text[] NOT NULL DEFAULT '{}',
      tags text[] NOT NULL DEFAULT '{}',
      ${timestamps}
    )`);
    await sql(`CREATE INDEX contacts_org_id_idx ON contacts (org_id)`);

    await sql(`CREATE TABLE contact_requests (
      ${id},
      org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
      action text NOT NULL CHECK (action IN ('create', 'update', 'delete')),
      payload jsonb NOT NULL,
      requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
      status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
      decided_by uuid REFERENCES users(id) ON DELETE SET NULL,
      decided_at timestamptz,
      ${timestamps}
    )`);
    await sql(
      `CREATE INDEX contact_requests_org_id_idx ON contact_requests (org_id, status)`,
    );

    // Append-only logs: no updated_at
    await sql(`CREATE TABLE activity_events (
      ${id},
      org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
      type text NOT NULL,
      target_type text,
      target_id text,
      payload jsonb NOT NULL DEFAULT '{}',
      ip_encrypted text,
      user_agent text,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await sql(
      `CREATE INDEX activity_events_org_created_idx ON activity_events (org_id, created_at DESC)`,
    );

    await sql(`CREATE TABLE user_security_events (
      ${id},
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type text NOT NULL,
      payload jsonb NOT NULL DEFAULT '{}',
      ip_encrypted text,
      user_agent text,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await sql(
      `CREATE INDEX user_security_events_user_created_idx ON user_security_events (user_id, created_at DESC)`,
    );

    await sql(`CREATE TABLE processed_events (
      event_key text PRIMARY KEY,
      processed_at timestamptz NOT NULL DEFAULT now()
    )`);

    // ---- last-admin invariant (amendment A4: lock the org row, then count) ----
    await sql(`CREATE FUNCTION org_keep_one_admin() RETURNS trigger
      LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
      DECLARE
        changed record;
        target_org uuid;
        org_status text;
      BEGIN
        -- INSERT can create an org without an admin; UPDATE/DELETE can remove one
        IF TG_OP = 'INSERT' THEN changed := NEW; ELSE changed := OLD; END IF;
        IF TG_TABLE_NAME = 'organizations' THEN
          -- created active, or restored to active
          target_org := NEW.id;
        ELSIF TG_TABLE_NAME = 'members' THEN
          target_org := changed.org_id;
        ELSE
          SELECT org_id INTO target_org FROM members WHERE id = changed.member_id;
        END IF;

        -- NO KEY UPDATE, not UPDATE: it must not conflict with the KEY SHARE
        -- locks that concurrent member inserts take through their foreign key
        -- (FOR UPDATE deadlocks two concurrent joins of the same org).
        -- Relies on READ COMMITTED: the count below takes a fresh snapshot
        -- after the lock, so it sees what the previous lock holder committed.
        SELECT status INTO org_status FROM organizations WHERE id = target_org FOR NO KEY UPDATE;
        -- gone (purged with its members) or deleted: nothing to keep
        IF org_status IS DISTINCT FROM 'active' THEN
          RETURN NULL;
        END IF;

        IF NOT EXISTS (
          SELECT 1
          FROM members m
          JOIN role_bindings rb ON rb.member_id = m.id
          JOIN roles r ON r.id = rb.role_id
          WHERE m.org_id = target_org
            AND m.status = 'active'
            AND rb.scope = 'org'
            AND r.key = 'admin'
            AND r.org_id IS NULL
        ) THEN
          RAISE EXCEPTION 'organization % must keep at least one active admin', target_org
            USING ERRCODE = 'check_violation', CONSTRAINT = 'members_keep_one_admin';
        END IF;
        RETURN NULL;
      END;
      $$`);
    for (const table of ['members', 'role_bindings']) {
      await sql(`CREATE CONSTRAINT TRIGGER members_keep_one_admin
        AFTER INSERT OR UPDATE OR DELETE ON ${table}
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION org_keep_one_admin()`);
    }
    await sql(`CREATE CONSTRAINT TRIGGER members_keep_one_admin
      AFTER INSERT OR UPDATE OF status ON organizations
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION org_keep_one_admin()`);

    // ---- row-level security (amendment A3: address book only) ----
    for (const table of ['contacts', 'contact_requests']) {
      await sql(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      await sql(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      await sql(`CREATE POLICY ${table}_org_isolation ON ${table} TO PUBLIC
        USING (org_id = ${CURRENT_ORG})
        WITH CHECK (org_id = ${CURRENT_ORG})`);
    }

    await queryRunner.query(
      `INSERT INTO roles (org_id, key, name, permissions, version) VALUES
        (NULL, 'admin', 'Admin', $1, 1),
        (NULL, 'member', 'Member', $2, 1)`,
      [ADMIN_PERMISSIONS, MEMBER_PERMISSIONS],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS
      processed_events, user_security_events, activity_events, contact_requests,
      contacts, linked_safe_snapshots, linked_safes, invitations, role_bindings,
      members, roles, organizations, recovery_codes, factors, sessions,
      identities, users CASCADE`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS org_keep_one_admin()`);
  }
}
