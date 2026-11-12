import type { IConfigurationService } from '@/config/configuration.service.interface';
import {
  acceptedIssuers,
  OidcClient,
} from '@/modules/org/auth/oidc/oidc.client';
import {
  startOidcMock,
  type OidcMock,
} from '../../../../../test/org/oidc-mock.server';

const clock = { now: (): Date => new Date() };

function client(issuer: string): OidcClient {
  const config = {
    getOrThrow: (k: string): unknown =>
      ({
        'org.oidc.issuer': issuer,
        'org.oidc.clientId': 'c',
        'org.oidc.clientSecret': 's',
        'org.oidc.redirectUri': 'https://api.example.com/cb',
      })[k],
  } as unknown as IConfigurationService;
  return new OidcClient(config, clock);
}

describe('acceptedIssuers', () => {
  it('accepts both Google iss forms for the Google issuer', () => {
    expect(acceptedIssuers('https://accounts.google.com')).toEqual([
      'https://accounts.google.com',
      'accounts.google.com',
    ]);
  });

  it('accepts only the configured issuer otherwise', () => {
    expect(acceptedIssuers('http://127.0.0.1:4010/')).toEqual([
      'http://127.0.0.1:4010/',
    ]);
  });
});

describe('OidcClient discovery', () => {
  const mocks: Array<OidcMock> = [];
  afterAll(() => Promise.all(mocks.map((m) => m.close())));

  const args = { state: 's', nonce: 'n', codeChallenge: 'c' };

  it('uses the authorization endpoint of the discovery document', async () => {
    const mock = await startOidcMock({ clientId: 'c', clientSecret: 's' });
    mocks.push(mock);
    const url = new URL(await client(mock.issuer).authorizeUrl(args));
    expect(url.toString()).toMatch(new RegExp(`^${mock.issuer}authorize\\?`));
  });

  it('refuses a discovery document naming another issuer', async () => {
    const mock = await startOidcMock({
      clientId: 'c',
      clientSecret: 's',
      discoveryIssuer: 'https://evil.example.com',
    });
    mocks.push(mock);
    await expect(client(mock.issuer).authorizeUrl(args)).rejects.toThrow(
      'discovery issuer does not match',
    );
  });

  it('fetches discovery once and retries after a failure', async () => {
    const mock = await startOidcMock({ clientId: 'c', clientSecret: 's' });
    mocks.push(mock);
    const fetchSpy = jest.spyOn(global, 'fetch');
    try {
      const c = client(mock.issuer);
      fetchSpy.mockRejectedValueOnce(new Error('down'));
      await expect(c.authorizeUrl(args)).rejects.toThrow('down');
      await c.authorizeUrl(args);
      await c.authorizeUrl(args);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
