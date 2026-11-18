import { safeReturnTo } from '@/modules/org/auth/oidc/oidc.service';

describe('safeReturnTo', () => {
  it.each(['/organizations', '/orgs/abc?tab=1#x', '/a/b%2F'])(
    'keeps the relative path %s',
    (path) => expect(safeReturnTo(path)).toBe(path),
  );

  it.each([
    undefined,
    '',
    'orgs',
    '//evil.example.com',
    '/\\evil.example.com',
    '/a\\b',
    'https://evil.example.com/',
    'javascript:alert(1)',
    '/a\r\nSet-Cookie: x=1',
    '/a\tb',
    `/${'a'.repeat(2048)}`,
  ])('falls back to /organizations for %p', (value) =>
    expect(safeReturnTo(value)).toBe('/organizations'),
  );
});
