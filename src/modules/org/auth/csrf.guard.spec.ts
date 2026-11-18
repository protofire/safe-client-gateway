import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import type { IConfigurationService } from '@/config/configuration.service.interface';
import { CsrfGuard } from '@/modules/org/auth/csrf.guard';

const APP_URL = 'https://app.example.com';

function context(
  method: string,
  headers: Record<string, string>,
): ExecutionContext {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        method,
        header: (name: string) => lower[name.toLowerCase()],
      }),
    }),
  } as unknown as ExecutionContext;
}

describe('CsrfGuard', () => {
  const guard = new CsrfGuard({
    getOrThrow: () => APP_URL,
  } as unknown as IConfigurationService);

  it.each(['GET', 'HEAD', 'OPTIONS'])(
    'lets %s through without the header',
    (method) => {
      expect(guard.canActivate(context(method, {}))).toBe(true);
    },
  );

  it.each(['POST', 'PATCH', 'PUT', 'DELETE'])(
    'rejects %s without X-Org-Request with 403',
    (method) => {
      expect(() => guard.canActivate(context(method, {}))).toThrow(
        ForbiddenException,
      );
    },
  );

  it('rejects X-Org-Request with a value other than 1', () => {
    expect(() =>
      guard.canActivate(context('POST', { 'X-Org-Request': 'true' })),
    ).toThrow(ForbiddenException);
  });

  it('accepts POST with X-Org-Request: 1 and no Origin', () => {
    expect(guard.canActivate(context('POST', { 'X-Org-Request': '1' }))).toBe(
      true,
    );
  });

  it('accepts POST from the public app origin', () => {
    expect(
      guard.canActivate(
        context('POST', { 'X-Org-Request': '1', Origin: APP_URL }),
      ),
    ).toBe(true);
  });

  it('rejects POST from another origin even with the header', () => {
    expect(() =>
      guard.canActivate(
        context('POST', {
          'X-Org-Request': '1',
          Origin: 'https://evil.example.com',
        }),
      ),
    ).toThrow(ForbiddenException);
  });
});
