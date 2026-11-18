import { z } from 'zod';

/**
 * Characters a reader cannot see or that reorder text: controls, format
 * characters (bidi, zero-width, BOM), line/paragraph separators, default
 * ignorables (variation selectors, tags, Hangul fillers, U+034F…) and the
 * braille blank. Migration 0009 freezes the same set for the DB check.
 */
export const INVISIBLE =
  /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}⠀]/u;

/** Names the UI shows for people without a name of their own. */
export const RESERVED_NAMES = ['deleted user', 'you', 'a member'];

/** Case-folded, whitespace runs as one space: how reserved names compare. */
export const foldName = (v: string): string =>
  v.toLowerCase().replace(/\s+/gu, ' ');

/** Length in code points, as Postgres `length()` counts. */
const codePoints = (v: string): number => [...v].length;

// Emoji sequences use U+FE0F (presentation) and U+200D (joiner) between pictographs: not hidden text
const EMOJI_JOINERS =
  /(?<=\p{Extended_Pictographic}[\u{1F3FB}-\u{1F3FF}]?)\uFE0F|(?<=\p{Extended_Pictographic}[\u{1F3FB}-\u{1F3FF}]?\uFE0F?)\u200D(?=\p{Extended_Pictographic})/gu;

/** The text with the joiners of emoji sequences removed, for the invisible-character check only */
export const withoutEmojiJoiners = (v: string): string =>
  v.replace(EMOJI_JOINERS, '');

/**
 * NFC, no invisible characters (checked before trim), trimmed, 1..max code
 * points, no leading combining mark. `multiline`: `\n` allowed (`\r\n` and
 * `\r` become `\n`). `emoji`: the joiners inside emoji sequences are allowed
 * (names of Safes and contacts; display names stay strict, their DB check mirrors this file).
 */
export function visibleText(
  max: number,
  {
    multiline = false,
    emoji = false,
  }: { multiline?: boolean; emoji?: boolean } = {},
): z.ZodType<string, string> {
  return z
    .string()
    .meta({ minLength: 1, maxLength: max })
    .transform((v) => {
      const nfc = v.normalize('NFC');
      return multiline ? nfc.replace(/\r\n?/g, '\n') : nfc;
    })
    .refine(
      (v) => {
        const text = multiline ? v.replaceAll('\n', '') : v;
        return !INVISIBLE.test(emoji ? withoutEmojiJoiners(text) : text);
      },
      {
        error: 'No control, format or invisible characters',
      },
    )
    .transform((v) => v.trim())
    .refine((v) => codePoints(v) >= 1 && codePoints(v) <= max, {
      error: `Must be 1 to ${max} characters`,
    })
    .refine((v) => !/^\p{M}/u.test(v), {
      error: 'Must not start with a combining mark',
    });
}

/** A person's display name; mirrored by the users CHECKs (0007-0009). */
export const DisplayName = visibleText(64)
  .refine((v) => /[\p{L}\p{N}]/u.test(v), {
    error: 'Must contain a letter or digit',
  })
  .refine((v) => !/^0x[0-9a-f]/i.test(v), {
    error: 'Must not look like an address',
  })
  .refine((v) => !RESERVED_NAMES.includes(foldName(v)), {
    error: 'This name is reserved',
  });
