import type { MigrationInterface, QueryRunner } from 'typeorm';

const FUNCTION = (activeUsersOnly: boolean): string => `
CREATE OR REPLACE FUNCTION org_keep_one_admin() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
  DECLARE
    changed record;
    target_org uuid;
    org_status text;
  BEGIN
    IF TG_OP = 'INSERT' THEN changed := NEW; ELSE changed := OLD; END IF;
    IF TG_TABLE_NAME = 'organizations' THEN
      target_org := NEW.id;
    ELSIF TG_TABLE_NAME = 'members' THEN
      target_org := changed.org_id;
    ELSE
      SELECT org_id INTO target_org FROM members WHERE id = changed.member_id;
    END IF;

    -- see 0001: NO KEY UPDATE, READ COMMITTED
    SELECT status INTO org_status FROM organizations WHERE id = target_org FOR NO KEY UPDATE;
    IF org_status IS DISTINCT FROM 'active' THEN
      RETURN NULL;
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM members m
      ${activeUsersOnly ? "JOIN users u ON u.id = m.user_id AND u.status = 'active'" : ''}
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
  $$`;

/**
 * Gate B F2: an admin whose user is deleted does not keep the org alive.
 * Same function as 0001 plus the join on active users.
 */
export class AdminTriggerActiveUsers1794441600000 implements MigrationInterface {
  name = 'AdminTriggerActiveUsers1794441600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(FUNCTION(true));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(FUNCTION(false));
  }
}
