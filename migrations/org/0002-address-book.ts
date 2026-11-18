import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Address book hardening: `contacts.version` is bumped on every change and
 * captured by update/delete requests (`contact_requests.contact_version`), so
 * an approval can tell the contact changed since the request was made. The
 * unique index backs the service-level (org, address) uniqueness check.
 */
export class AddressBook1794268800000 implements MigrationInterface {
  name = 'AddressBook1794268800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE contacts ADD COLUMN version integer NOT NULL DEFAULT 1`,
    );
    await queryRunner.query(
      `ALTER TABLE contact_requests ADD COLUMN contact_version integer`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX contacts_org_address_key ON contacts (org_id, address)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS contacts_org_address_key`);
    await queryRunner.query(
      `ALTER TABLE contact_requests DROP COLUMN IF EXISTS contact_version`,
    );
    await queryRunner.query(
      `ALTER TABLE contacts DROP COLUMN IF EXISTS version`,
    );
  }
}
