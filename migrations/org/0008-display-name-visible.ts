import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Unicode 17 format characters (Cf: bidi controls, zero-width, BOM, tags…),
 * line/paragraph separators and blank "letters" (Hangul fillers, braille
 * blank). Frozen here; the API rejects \p{Cf} of the runtime's Unicode too.
 */
const INVISIBLE: Array<[number, number]> = [
  [0xad, 0xad], [0x600, 0x605], [0x61c, 0x61c], [0x6dd, 0x6dd],
  [0x70f, 0x70f], [0x890, 0x891], [0x8e2, 0x8e2], [0x115f, 0x1160],
  [0x180e, 0x180e], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2064],
  [0x2066, 0x206f], [0x2800, 0x2800], [0x3164, 0x3164], [0xfeff, 0xfeff],
  [0xffa0, 0xffa0], [0xfff9, 0xfffb], [0x110bd, 0x110bd], [0x110cd, 0x110cd],
  [0x13430, 0x1343f], [0x1bca0, 0x1bca3], [0x1d173, 0x1d17a],
  [0xe0001, 0xe0001], [0xe0020, 0xe007f],
];

const CLASS = INVISIBLE.map(([a, b]) =>
  a === b
    ? String.fromCodePoint(a)
    : `${String.fromCodePoint(a)}-${String.fromCodePoint(b)}`,
).join('');

/** Display names: NFC and no invisible characters (impersonation, spoofed bidi). */
export class DisplayNameVisible1794787200000 implements MigrationInterface {
  name = 'DisplayNameVisible1794787200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(
      `ALTER TABLE users ADD CONSTRAINT users_display_name_visible_check CHECK (
        display_name IS NFC NORMALIZED AND display_name !~ $$[${CLASS}]$$)`,
    );
    await queryRunner.query(`SET LOCAL lock_timeout = DEFAULT`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE users DROP CONSTRAINT users_display_name_visible_check`,
    );
  }
}
