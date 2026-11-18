import { createHash } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { conflict } from '@/modules/org/orgs/org-lock';
import type { Kind } from '@/modules/org/safes/transactions/tx-kind';

export const MAX_CURSOR_BYTES = 512;

const Iso = z.iso.datetime();
const Chain = z.string().regex(/^[1-9]\d{0,19}$/);
const Lower = z.string().regex(/^0x[0-9a-f]{40}$/);

/** History key: (executedAt desc, chainId asc, safeAddress asc, nonce desc). */
export const HistoryKeySchema = z.object({
  t: Iso,
  c: Chain,
  a: Lower,
  n: z.number().int().nonnegative(),
});
export type HistoryKey = z.infer<typeof HistoryKeySchema>;

/** Queue key: (submittedAt desc, chainId asc, safeAddress asc, safeTxHash asc). */
export const QueueKeySchema = z.object({
  t: Iso,
  c: Chain,
  a: Lower,
  h: z.string().regex(/^0x[0-9a-f]{64}$/),
});
export type QueueKey = z.infer<typeof QueueKeySchema>;

const CursorSchema = z.object({
  v: z.literal(1),
  k: z.record(z.string(), z.unknown()),
  s: z.string(),
});

export type CursorScope = {
  tab: 'queue' | 'history';
  mine?: boolean;
  kind?: ReadonlyArray<Kind>;
  linkedSafeId?: ReadonlyArray<string>;
  chainId?: ReadonlyArray<string>;
  /** linked Safe ids in scope after the filters apply */
  scopeSafeIds: ReadonlyArray<string>;
};

/** First 16 hex of sha256 over the tab, filters and in-scope Safe ids (order-insensitive). */
export function scopeHash(scope: CursorScope): string {
  const sorted = (a?: ReadonlyArray<string>): Array<string> =>
    [...(a ?? [])].sort();
  const body = JSON.stringify([
    scope.tab,
    scope.mine === true,
    sorted(scope.kind),
    sorted(scope.linkedSafeId),
    sorted(scope.chainId),
    sorted(scope.scopeSafeIds),
  ]);
  return createHash('sha256').update(body).digest('hex').slice(0, 16);
}

export function encodeCursor(k: HistoryKey | QueueKey, s: string): string {
  return Buffer.from(JSON.stringify({ v: 1, k, s })).toString('base64url');
}

/**
 * 400 when malformed (envelope, then key schema) or over 512 bytes; 409 `cursor_stale` when the scope
 * hash differs (another tab, other filters, a Safe linked or unlinked); the
 * scope is checked before the key schema, so a cross-tab cursor is 409.
 */
export function decodeCursor<K>(
  raw: string,
  expectedScope: string,
  keySchema: z.ZodType<K>,
): K {
  const invalid = (): BadRequestException =>
    new BadRequestException('Invalid cursor');
  if (raw.length > MAX_CURSOR_BYTES || !/^[A-Za-z0-9_-]+$/.test(raw))
    throw invalid();
  let parsed: z.infer<typeof CursorSchema>;
  try {
    parsed = CursorSchema.parse(
      JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')),
    );
  } catch {
    throw invalid();
  }
  if (parsed.s !== expectedScope) {
    throw conflict('cursor_stale', 'The list changed; reload the first page');
  }
  const key = keySchema.safeParse(parsed.k);
  if (!key.success) throw invalid();
  return key.data;
}
