import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Email invitations keep the target address encrypted (FieldEncryptionService)
 * so admins see whom they invited and renewals can be mailed again; lookups
 * still go through `target_email_hash` (HMAC, amendment A14).
 */
export class InvitationTargetEmail1794355200000 implements MigrationInterface {
  name = 'InvitationTargetEmail1794355200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE invitations ADD COLUMN target_email_encrypted text`,
    );
    await queryRunner.query(
      `ALTER TABLE invitations ADD CONSTRAINT invitations_email_encrypted_check
         CHECK (target_kind = 'wallet' OR target_email_encrypted IS NOT NULL)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE invitations DROP COLUMN target_email_encrypted`,
    );
  }
}
