import type { MigrationInterface, QueryRunner } from 'typeorm';

/** `sessions.ip_encrypted` was never written; the IP lives in the security log. */
export class DropSessionIp1794528000000 implements MigrationInterface {
  name = 'DropSessionIp1794528000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE sessions DROP COLUMN ip_encrypted`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE sessions ADD COLUMN ip_encrypted text`,
    );
  }
}
