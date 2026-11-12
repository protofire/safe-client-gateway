import type request from 'supertest';
import { IConfigurationService } from '@/config/configuration.service.interface';
import { OrgOidcModule } from '@/modules/org/auth/oidc/oidc.module';
import { EMAIL_OTP_ISSUER } from '@/modules/org/auth/oidc/oidc.service';
import { hmacEmail } from '@/modules/org/crypto/hashing';
import {
  APP_URL,
  cookieFrom,
  createAuthTestApp,
  type AuthTestApp,
} from '@/modules/org/auth/__tests__/auth-test-app';
import {
  startOidcMock,
  type OidcMock,
} from '../../../../../test/org/oidc-mock.server';

const CLIENT_ID = 'test-client';
const REDIRECT_URI = 'https://api.example.com/v1/orgs/auth/oidc/callback';

describe('OIDC sign-in (org)', () => {
  let mock: OidcMock;
  let t: AuthTestApp;

  beforeAll(async () => {
    mock = await startOidcMock({
      clientId: CLIENT_ID,
      clientSecret: 'test-secret',
    });
    t = await createAuthTestApp({
      redisDb: 3,
      imports: [OrgOidcModule],
      config: {
        'org.oidc.issuer': mock.issuer,
        'org.oidc.clientId': CLIENT_ID,
        'org.oidc.clientSecret': 'test-secret',
        'org.oidc.redirectUri': REDIRECT_URI,
        'org.oidc.postLoginRedirect': `${APP_URL}/`,
      },
    });
  });

  afterAll(async () => {
    await t?.close();
    await mock?.close();
  });

  beforeEach(async () => {
    mock.setClaims({});
    mock.setSigning('jwks');
    await t.reset();
  });

  type Started = {
    txCookie: string;
    code: string;
    state: string;
    authorizeUrl: URL;
  };

  /** Our authorize → the IdP's authorize; returns what the browser holds at the callback. */
  async function start(
    query = '',
    email = 'alice@example.com',
  ): Promise<Started> {
    const res = await t
      .http()
      .get(`/v1/orgs/auth/oidc/authorize?${query}`)
      .expect(302);
    const authorizeUrl = new URL(res.headers.location);
    authorizeUrl.searchParams.set('login_hint', email);
    const idp = await fetch(authorizeUrl, { redirect: 'manual' });
    const back = new URL(idp.headers.get('location')!);
    return {
      txCookie: cookieFrom(res, '__Host-org_oidc_tx'),
      code: back.searchParams.get('code')!,
      state: back.searchParams.get('state')!,
      authorizeUrl,
    };
  }

  function callback(
    s: Pick<Started, 'code' | 'state'>,
    cookie?: string,
  ): request.Test {
    const req = t
      .http()
      .get(
        `/v1/orgs/auth/oidc/callback?code=${encodeURIComponent(s.code)}&state=${encodeURIComponent(s.state)}`,
      );
    return cookie ? req.set('Cookie', cookie) : req;
  }

  /** Item 5: every callback failure is a 302 back to the app with ?orgAuthError. */
  async function failsWith(
    test: request.Test,
    code: string,
    path = '/organizations',
  ): Promise<request.Response> {
    const res = await test.expect(302);
    expect(res.headers.location).toBe(`${APP_URL}${path}?orgAuthError=${code}`);
    expect([res.headers['set-cookie']].flat().join()).not.toMatch(
      /__Host-org_session=[^;]/,
    );
    return res;
  }

  it("redirects to the discovery document's authorization endpoint with PKCE S256, state, nonce and scope, and sets __Host-org_oidc_tx", async () => {
    const res = await t
      .http()
      .get('/v1/orgs/auth/oidc/authorize?returnTo=/x')
      .expect(302);
    const url = new URL(res.headers.location);
    expect(`${url.origin}/`).toBe(mock.issuer);
    expect(url.pathname).toBe('/authorize');
    const q = Object.fromEntries(url.searchParams);
    expect(q).toEqual({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: 'openid email profile',
      state: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      nonce: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      code_challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      code_challenge_method: 'S256',
    });
    const cookie = [res.headers['set-cookie']]
      .flat()
      .find((c) => c.startsWith('__Host-org_oidc_tx='))!;
    expect(cookie).toMatch(/; HttpOnly/);
    expect(cookie).toMatch(/; Secure/);
    expect(cookie).toMatch(/; SameSite=Lax/);
    expect(cookie).toMatch(/; Path=\/;/);
    expect(cookie).not.toMatch(/; Domain=/i);
    expect(cookie).toMatch(/; Max-Age=600;/);
  });

  it('completes the code flow with the mock issuer and sets a session (amr oidc, not strong)', async () => {
    const s = await start('returnTo=%2Forgs%2Fabc%3Ftab%3D1');
    const res = await callback(s, s.txCookie).expect(302);
    expect(res.headers.location).toBe(`${APP_URL}/orgs/abc?tab=1`);
    const setCookies = [res.headers['set-cookie']].flat();
    expect(setCookies.find((c) => c.startsWith('__Host-org_oidc_tx='))).toMatch(
      /^__Host-org_oidc_tx=;/,
    );
    const session = cookieFrom(res, '__Host-org_session');

    const me = await t
      .http()
      .get('/v1/orgs/auth/me')
      .set('Cookie', session)
      .expect(200);
    expect(me.body).toEqual({
      user: { id: expect.any(String) },
      identities: [
        {
          id: expect.any(String),
          kind: 'oidc',
          issuer: mock.issuer,
          email: 'alice@example.com',
        },
      ],
      hasTotp: false,
      lastStrongAuthAt: null,
      canCreateOrganization: true,
    });
    const [row] = await t.sql.query(
      `SELECT s.amr, s.last_strong_auth_at, i.email_encrypted, i.email_hash
       FROM sessions s JOIN identities i ON i.user_id = s.user_id WHERE s.user_id = $1`,
      [me.body.user.id],
    );
    expect(row.amr).toEqual(['oidc']);
    expect(row.last_strong_auth_at).toBeNull();
    expect(row.email_encrypted).not.toContain('alice');
    expect(row.email_hash).toMatch(/^[0-9a-f]{64}$/);
    const [event] = await t.sql.query(
      `SELECT type, payload FROM user_security_events WHERE user_id = $1`,
      [me.body.user.id],
    );
    expect(event).toEqual({
      type: 'security.signed_in',
      payload: { method: 'oidc' },
    });
  });

  it('signs the same identity into the same user; the same verified email under a new subject is a new user, the existing one untouched', async () => {
    const a = await callback(...withCookie(await start())).expect(302);
    const b = await callback(...withCookie(await start())).expect(302);
    const idOf = async (res: request.Response): Promise<string> =>
      (
        await t
          .http()
          .get('/v1/orgs/auth/me')
          .set('Cookie', cookieFrom(res, '__Host-org_session'))
      ).body.user.id;
    const alice = await idOf(a);
    expect(await idOf(b)).toBe(alice);
    const identitiesOf = (userId: string): Promise<Array<unknown>> =>
      t.sql.query(
        `SELECT id, oidc_subject, email_hash FROM identities WHERE user_id = $1 ORDER BY id`,
        [userId],
      );
    const eventsOf = (userId: string): Promise<Array<unknown>> =>
      t.sql.query(
        `SELECT type, payload FROM user_security_events WHERE user_id = $1 ORDER BY created_at`,
        [userId],
      );
    const aliceIdentities = await identitiesOf(alice);
    const aliceEvents = await eventsOf(alice);

    // same verified email, other subject: never attached implicitly
    mock.setClaims({ sub: '987654321' });
    const c = await callback(...withCookie(await start())).expect(302);
    const other = await idOf(c);
    expect(other).not.toBe(alice);
    expect(await identitiesOf(other)).toEqual([
      expect.objectContaining({ oidc_subject: '987654321' }),
    ]);
    expect(await identitiesOf(alice)).toEqual(aliceIdentities);
    expect(await eventsOf(alice)).toEqual(aliceEvents);
  });

  it('stores the numeric subject under the configured issuer', async () => {
    const res = await callback(...withCookie(await start())).expect(302);
    const me = await t
      .http()
      .get('/v1/orgs/auth/me')
      .set('Cookie', cookieFrom(res, '__Host-org_session'))
      .expect(200);
    const [row] = await t.sql.query(
      `SELECT oidc_issuer, oidc_subject FROM identities WHERE user_id = $1`,
      [me.body.user.id],
    );
    expect(row).toEqual({
      oidc_issuer: mock.issuer,
      oidc_subject: expect.stringMatching(/^\d+$/),
    });
  });

  it('adds orgLinkHint=1 when another user signs in with a code to the same email, and never merges', async () => {
    const key = Buffer.from(
      t.app
        .get<IConfigurationService>(IConfigurationService)
        .getOrThrow<string>('org.emailHashKey'),
      'base64',
    );
    const hash = hmacEmail('alice@example.com', key);
    const [{ id: other }] = await t.sql.query(
      `INSERT INTO users DEFAULT VALUES RETURNING id`,
    );
    await t.sql.query(
      `INSERT INTO identities (user_id, kind, oidc_issuer, oidc_subject, email_hash)
       VALUES ($1, 'oidc', $2, $3, $3)`,
      [other, EMAIL_OTP_ISSUER, hash],
    );
    const res = await callback(
      ...withCookie(await start('returnTo=%2Forgs%3Ftab%3D1')),
    ).expect(302);
    expect(res.headers.location).toBe(`${APP_URL}/orgs?tab=1&orgLinkHint=1`);
    const me = await t
      .http()
      .get('/v1/orgs/auth/me')
      .set('Cookie', cookieFrom(res, '__Host-org_session'))
      .expect(200);
    expect(me.body.user.id).not.toBe(other);
    expect(me.body.identities).toHaveLength(1);

    // without such an identity: no hint
    await t.sql.query(`DELETE FROM identities WHERE user_id = $1`, [other]);
    const again = await callback(...withCookie(await start())).expect(302);
    expect(again.headers.location).toBe(`${APP_URL}/organizations`);
  });

  it('redirects a cancelled sign-in back to its returnTo with cancelled (item 5)', async () => {
    const s = await start('returnTo=%2Forgs%2Fx');
    await failsWith(
      t
        .http()
        .get(
          `/v1/orgs/auth/oidc/callback?error=access_denied&error_description=x&state=${encodeURIComponent(s.state)}`,
        )
        .set('Cookie', s.txCookie),
      'cancelled',
      '/orgs/x',
    );
    // the state was consumed
    await failsWith(callback(s, s.txCookie), 'expired');
  });

  it('rejects a callback without the __Host-org_oidc_tx cookie', async () => {
    const s = await start();
    await failsWith(callback(s), 'failed');
  });

  it("rejects a callback replayed in another browser (another browser's cookie)", async () => {
    const victim = await start();
    const attacker = await start();
    await failsWith(callback(victim, attacker.txCookie), 'failed');
  });

  it('rejects an unknown state as expired', async () => {
    const s = await start();
    await failsWith(
      callback({ code: s.code, state: 'not-a-state' }, s.txCookie),
      'expired',
    );
  });

  it('rejects a reused state as expired', async () => {
    const s = await start();
    await callback(s, s.txCookie).expect(302);
    await failsWith(callback(s, s.txCookie), 'expired');
  });

  it('rejects an ID token with email_verified=false', async () => {
    mock.setClaims({ email_verified: false });
    await failsWith(callback(...withCookie(await start())), 'failed');
  });

  it.each([
    ['wrong audience', { aud: 'another-client' }],
    ['wrong issuer', { iss: 'https://evil.example.com/' }],
    ['wrong nonce', { nonce: 'another-nonce' }],
    ['expired', { exp: Math.floor(Date.now() / 1000) - 60 }],
  ])('rejects an ID token with %s', async (_, claims) => {
    mock.setClaims(claims);
    await failsWith(callback(...withCookie(await start())), 'failed');
  });

  it.each(['foreign-key', 'none', 'HS256-client-secret'] as const)(
    'rejects an ID token signed with %s (F9)',
    async (signing) => {
      mock.setSigning(signing);
      await failsWith(callback(...withCookie(await start())), 'failed');
    },
  );

  it('rejects an ID token that expired by the injected clock', async () => {
    const s = await start();
    t.setOffset(11 * 60_000);
    // the mock's ID token lives 10 minutes; expiry is judged by the injected clock
    await failsWith(callback(s, s.txCookie), 'failed');
  });

  it.each([
    '//evil.example.com/x',
    '/\\evil.example.com',
    'https://evil.example.com/',
    'orgs',
    '/a\r\nSet-Cookie:x=1',
  ])('falls back to /organizations for returnTo %s', async (returnTo) => {
    const s = await start(`returnTo=${encodeURIComponent(returnTo)}`);
    const res = await callback(s, s.txCookie).expect(302);
    expect(res.headers.location).toBe(`${APP_URL}/organizations`);
  });

  function withCookie(s: Started): [Started, string] {
    return [s, s.txCookie];
  }
});
