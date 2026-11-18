import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  HistoryKeySchema,
  MAX_CURSOR_BYTES,
  QueueKeySchema,
  decodeCursor,
  encodeCursor,
  scopeHash,
  type CursorScope,
  type HistoryKey,
} from '@/modules/org/safes/transactions/cursor';
import { KINDS } from '@/modules/org/safes/transactions/tx-kind';

const uuid = (i: number): string =>
  `00000000-0000-4000-8000-${i.toString().padStart(12, '0')}`;

const scope: CursorScope = {
  tab: 'history',
  kind: ['transfer'],
  scopeSafeIds: [uuid(1), uuid(2)],
};
const key: HistoryKey = {
  t: '2026-11-18T10:00:00.000Z',
  c: '8453',
  a: '0x00000000000000000000000000000000000000ab',
  n: 41,
};

describe('cursor', () => {
  it('encodes and decodes a key under the same scope', () => {
    const s = scopeHash(scope);
    const raw = encodeCursor(key, s);

    expect(s).toMatch(/^[0-9a-f]{16}$/);
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(raw.length).toBeLessThan(MAX_CURSOR_BYTES);
    expect(decodeCursor(raw, s, HistoryKeySchema)).toEqual(key);
  });

  it('an old cursor with the same scope still works (no expiry); filter order does not matter', () => {
    const raw = encodeCursor(key, scopeHash(scope));
    const same = scopeHash({ ...scope, scopeSafeIds: [uuid(2), uuid(1)] });

    expect(decodeCursor(raw, same, HistoryKeySchema)).toEqual(key);
  });

  it.each([
    ['over 512 bytes', 'A'.repeat(MAX_CURSOR_BYTES + 1)],
    ['not base64url', 'a+b/c='],
    ['not JSON', Buffer.from('nope').toString('base64url')],
    [
      'wrong version',
      Buffer.from(JSON.stringify({ v: 2, k: key, s: 'x' })).toString(
        'base64url',
      ),
    ],
  ])('400 when %s', (_, raw) => {
    expect(() => decodeCursor(raw, scopeHash(scope), HistoryKeySchema)).toThrow(
      BadRequestException,
    );
  });

  it.each([
    ['k null', { v: 1, k: null, s: 'x' }],
    ['k an array', { v: 1, k: [], s: 'x' }],
    ['s not a string', { v: 1, k: key, s: 7 }],
  ])('400 on a bad envelope even with a foreign scope: %s', (_, body) => {
    const raw = Buffer.from(JSON.stringify(body)).toString('base64url');

    expect(() => decodeCursor(raw, scopeHash(scope), HistoryKeySchema)).toThrow(
      BadRequestException,
    );
  });

  it('409 for a cross-tab cursor whose key does not fit the other tab schema', () => {
    const raw = encodeCursor(key, scopeHash(scope));
    const queueScope = scopeHash({ ...scope, tab: 'queue' });

    expect(() => decodeCursor(raw, queueScope, QueueKeySchema)).toThrow(
      ConflictException,
    );
  });

  it('400 when the key does not fit the tab schema', () => {
    const s = scopeHash(scope);
    const raw = encodeCursor({ ...key, n: -1 }, s);

    expect(() => decodeCursor(raw, s, HistoryKeySchema)).toThrow(
      BadRequestException,
    );
  });

  it.each<[string, CursorScope]>([
    ['another tab', { ...scope, tab: 'queue' }],
    ['other filters', { ...scope, kind: ['settings'] }],
    ['mine toggled', { ...scope, mine: true }],
    ['a Safe linked', { ...scope, scopeSafeIds: [uuid(1), uuid(2), uuid(3)] }],
    ['a Safe unlinked', { ...scope, scopeSafeIds: [uuid(1)] }],
    ['a chain filter', { ...scope, chainId: ['1'] }],
  ])('409 cursor_stale on a scope change: %s', (_, other) => {
    const raw = encodeCursor(key, scopeHash(scope));

    let error: unknown;
    try {
      decodeCursor(raw, scopeHash(other), QueueKeySchema);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      statusCode: 409,
      code: 'cursor_stale',
    });
  });

  it('query string at the spec bounds stays within 4.6 KB', () => {
    const q = new URLSearchParams();
    q.set('tab', 'history');
    q.set('mine', 'true');
    for (let i = 0; i < 50; i++) q.append('linkedSafeId', uuid(i));
    for (let i = 0; i < 50; i++) q.append('chainId', '9'.repeat(20));
    for (const k of KINDS) q.append('kind', k);
    q.set('limit', '50');
    q.set('cursor', 'A'.repeat(MAX_CURSOR_BYTES));

    expect(q.toString().length).toBeLessThanOrEqual(4600);
  });
});
