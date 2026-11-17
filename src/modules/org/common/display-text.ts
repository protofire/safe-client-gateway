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

/** Length in code points, as Postgres `length()` counts. */
const codePoints = (v: string): number => [...v].length;

/** NFC, no invisible characters (checked before trim), trimmed, 1..max code points. */
export function visibleText(max: number): z.ZodType<string, string> {
  return z
    .string()
    .transform((v) => v.normalize('NFC'))
    .refine((v) => !INVISIBLE.test(v), {
      error: 'No control, format or invisible characters',
    })
    .transform((v) => v.trim())
    .refine((v) => codePoints(v) >= 1 && codePoints(v) <= max, {
      error: `Must be 1 to ${max} characters`,
    });
}

/** A person's display name; mirrored by the users CHECKs (0007-0009). */
export const DisplayName = visibleText(64)
  .refine((v) => /[\p{L}\p{N}]/u.test(v), {
    error: 'Must contain a letter or digit',
  })
  .refine((v) => !/^\p{M}/u.test(v), {
    error: 'Must not start with a combining mark',
  })
  .refine((v) => !/^0x[0-9a-f]/i.test(v), {
    error: 'Must not look like an address',
  })
  .refine((v) => !RESERVED_NAMES.includes(v.toLowerCase()), {
    error: 'This name is reserved',
  });
