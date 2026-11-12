import { Global, Module } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type request from 'supertest';
import type { Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { NetworkService } from '@/datasources/network/network.service.interface';
import { OrgAccountModule } from '@/modules/org/account/account.module';
import {
  APP_URL,
  cookieFrom,
  createAuthTestApp,
  seedUser,
  type AuthTestApp,
} from '@/modules/org/auth/__tests__/auth-test-app';
import { OrgOidcModule } from '@/modules/org/auth/oidc/oidc.module';
import { OrgTotpModule } from '@/modules/org/auth/totp/totp.module';
import { FieldEncryptionService } from '@/modules/org/crypto/field-encryption.service';
import { sha256Hex } from '@/modules/org/crypto/hashing';
import {
  startOidcMock,
  type OidcMock,
} from '../../../../test/org/oidc-mock.server';

jest.setTimeout(60_000);

const CLIENT_ID = 'test-client';
const MINUTES_31 = 31 * 60_000;

// MailService (email code linking) needs it; no mail is sent in this spec
@Global()
@Module({
  providers: [{ provide: NetworkService, useValue: { post: jest.fn() } }],
  exports: [NetworkService],
})
class NetworkStubModule {}

describe('identity linking (org)', () => {
  let mock: OidcMock;
  let t: AuthTestApp;

  beforeAll(async () => {
    mock = await startOidcMock({
      clientId: CLIENT_ID,
      clientSecret: 'test-secret',
    });
    t = await createAuthTestApp({
      redisDb: 6,
      imports: [
        NetworkStubModule,
        OrgOidcModule,
        OrgTotpModule,
        OrgAccountModule,
      ],
      config: {
        'org.oidc.issuer': mock.issuer,
        'org.oidc.clientId': CLIENT_ID,
        'org.oidc.clientSecret': 'test-secret',
        'org.oidc.redirectUri':
          'https://api.example.com/v1/orgs/auth/oidc/callback',
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
    await t.reset();
  });

  type User = { userId: string; cookie: string };

  /** Strong now unless `strong: false`; `wallet` adds a wallet identity. */
  async function user(
    opts: {
      wallet?: boolean;
      email?: boolean;
      totp?: boolean;
      strong?: boolean;
    } = {},
  ): Promise<User> {
    const u = await seedUser(t.sql, {
      wallet: opts.wallet,
      strongAt: opts.strong === false ? null : new Date(),
    });
    const encryption = t.app.get(FieldEncryptionService);
    if (opts.email) {
      await t.sql.query(
        `INSERT INTO identities (user_id, kind, oidc_issuer, oidc_subject, email_encrypted)
         VALUES ($1, 'oidc', $2, $3, $4)`,
        [
          u.userId,
          mock.issuer,
          `email|${randomBytes(8).toString('hex')}`,
          encryption.encrypt('someone@example.com'),
        ],
      );
    }
    if (opts.totp) {
      await t.sql.query(
        `INSERT INTO factors (user_id, kind, secret_encrypted, confirmed_at)
         VALUES ($1, 'totp', $2, now())`,
        [u.userId, encryption.encrypt('JBSWY3DPEHPK3PXP')],
      );
    }
    return u;
  }

  async function signed(pk: Hex): Promise<{ message: string; signature: Hex }> {
    const { nonce } = (
      await t
        .http()
        .get('/v1/orgs/auth/nonce')
        .set('X-Forwarded-For', ip())
        .expect(200)
    ).body;
    const account = privateKeyToAccount(pk);
    const message = createSiweMessage({
      address: account.address,
      chainId: 1,
      domain: 'app.example.com',
      nonce,
      uri: APP_URL,
      version: '1',
    });
    return { message, signature: await account.signMessage({ message }) };
  }

  let ipSeq = 0;
  const ip = (): string => `10.6.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;

  const linkSiwe = async (u: User, pk: Hex): Promise<request.Response> =>
    t
      .post('/v1/orgs/account/link/siwe')
      .set('Cookie', u.cookie)
      .send(await signed(pk));

  const identities = async (u: User): Promise<Array<Record<string, unknown>>> =>
    (await t.http().get('/v1/orgs/auth/me').set('Cookie', u.cookie).expect(200))
      .body.identities;

  const liveSessions = async (userId: string): Promise<number> =>
    (
      await t.sql.query(
        `SELECT count(*)::int AS n FROM sessions WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId],
      )
    )[0].n;

  /** A second session of the same user (another device). */
  async function secondSession(userId: string): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await t.sql.query(
      `INSERT INTO sessions (user_id, token_hash, amr, last_strong_auth_at, expires_at, idle_expires_at)
       VALUES ($1, $2, '{oidc}', now(), now() + interval '1 day', now() + interval '1 day')`,
      [userId, sha256Hex(token)],
    );
    return `__Host-org_session=${token}`;
  }

  describe('SIWE', () => {
    it('links a wallet to an email user and then counts SIWE step-up as strong', async () => {
      const u = await user({ email: true, totp: true });
      const pk = generatePrivateKey();
      const res = await linkSiwe(u, pk);
      expect(res.status).toBe(200);
      expect(await identities(u)).toEqual([
        expect.objectContaining({ kind: 'oidc' }),
        {
          id: expect.any(String),
          kind: 'wallet',
          walletAddress: privateKeyToAccount(pk).address,
        },
      ]);

      t.setOffset(MINUTES_31);
      const stepUp = await t
        .post('/v1/orgs/auth/step-up/siwe')
        .set('Cookie', u.cookie)
        .send(await signed(pk))
        .expect(200);
      const me = await t
        .http()
        .get('/v1/orgs/auth/me')
        .set('Cookie', cookieFrom(stepUp, '__Host-org_session'))
        .expect(200);
      expect(me.body.lastStrongAuthAt).not.toBeNull();

      const [event] = await t.sql.query(
        `SELECT payload FROM user_security_events WHERE user_id = $1 AND type = 'security.identity_linked'`,
        [u.userId],
      );
      expect(event.payload).toEqual({ kind: 'wallet' });
    });

    it('refuses a wallet owned by another user with 409 identity_taken', async () => {
      const pk = generatePrivateKey();
      const owner = await user({ wallet: true });
      await linkSiwe(owner, pk).then((r) => expect(r.status).toBe(200));
      const other = await user({ wallet: true });
      const res = await linkSiwe(other, pk);
      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        statusCode: 409,
        message: expect.any(String),
        code: 'identity_taken',
      });
    });

    it('answers 403 without fresh strong auth', async () => {
      const u = await user({ wallet: true, strong: false });
      const res = await linkSiwe(u, generatePrivateKey());
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('step_up_required');
    });

    it('answers 403 totp_required for an email-only user without TOTP', async () => {
      const u = await user({ email: true });
      const res = await linkSiwe(u, generatePrivateKey());
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('totp_required');
    });

    it('revokes the other sessions after linking', async () => {
      const u = await user({ wallet: true });
      const other = await secondSession(u.userId);
      expect(await liveSessions(u.userId)).toBe(2);
      expect((await linkSiwe(u, generatePrivateKey())).status).toBe(200);
      expect(await liveSessions(u.userId)).toBe(1);
      await t.http().get('/v1/orgs/auth/me').set('Cookie', other).expect(401);
      await t
        .http()
        .get('/v1/orgs/auth/me')
        .set('Cookie', u.cookie)
        .expect(200);
    });
  });

  describe('OIDC', () => {
    type Started = { txCookie: string; code: string; state: string };

    async function startLink(
      u: User,
      body: object = { returnTo: '/settings' },
      email = 'linked@example.com',
    ): Promise<Started> {
      const res = await t
        .post('/v1/orgs/account/link/oidc/authorize')
        .set('Cookie', u.cookie)
        .send(body)
        .expect(200);
      expect(res.body).toEqual({ redirectUrl: expect.any(String) });
      const authorizeUrl = new URL(res.body.redirectUrl as string);
      // item 4: the user picks the account at the IdP, never a silent reuse
      expect(authorizeUrl.searchParams.get('prompt')).toBe('select_account');
      expect(authorizeUrl.searchParams.has('max_age')).toBe(false);
      authorizeUrl.searchParams.set('login_hint', email);
      const idp = await fetch(authorizeUrl, { redirect: 'manual' });
      const back = new URL(idp.headers.get('location')!);
      return {
        txCookie: cookieFrom(res, '__Host-org_oidc_tx'),
        code: back.searchParams.get('code')!,
        state: back.searchParams.get('state')!,
      };
    }

    const callback = (s: Started, cookies: Array<string>): request.Test =>
      t
        .http()
        .get(
          `/v1/orgs/auth/oidc/callback?code=${encodeURIComponent(s.code)}&state=${encodeURIComponent(s.state)}`,
        )
        .set('Cookie', cookies.join('; '));

    /** Item 5: callback failures redirect to the flow's returnTo with ?orgAuthError. */
    async function failsWith(
      test: request.Test,
      code: string,
      path = '/settings',
    ): Promise<void> {
      const res = await test.expect(302);
      expect(res.headers.location).toBe(
        `${APP_URL}${path}?orgAuthError=${code}`,
      );
    }

    it('starts with POST only: GET is gone and POST needs the CSRF header (item 4)', async () => {
      const u = await user({ wallet: true });
      await t
        .http()
        .get('/v1/orgs/account/link/oidc/authorize')
        .set('Cookie', u.cookie)
        .expect(404);
      await t
        .http()
        .post('/v1/orgs/account/link/oidc/authorize')
        .set('Cookie', u.cookie)
        .send({})
        .expect(403);
      const res = await t
        .post('/v1/orgs/account/link/oidc/authorize')
        .set('Cookie', u.cookie)
        .send({})
        .expect(200);
      const cookie = [res.headers['set-cookie']]
        .flat()
        .find((c) => c.startsWith('__Host-org_oidc_tx='))!;
      expect(cookie).toMatch(/; Path=\/;/);
      expect(cookie).not.toMatch(/; Domain=/i);
      expect(cookie).toMatch(/; HttpOnly/);
      expect(
        new URL(res.body.redirectUrl as string).searchParams.has('connection'),
      ).toBe(false);
    });

    it('attaches the identity to the current user without creating a session', async () => {
      const u = await user({ wallet: true });
      const s = await startLink(u);
      const usersBefore = await countUsers();
      const res = await callback(s, [s.txCookie, u.cookie]).expect(302);
      expect(await countUsers()).toBe(usersBefore);
      expect(res.headers.location).toBe(`${APP_URL}/settings`);
      expect([res.headers['set-cookie']].flat().join()).not.toMatch(
        /__Host-org_session=[^;]/,
      );
      expect(await liveSessions(u.userId)).toBe(1);
      expect(await identities(u)).toEqual([
        expect.objectContaining({ kind: 'wallet' }),
        {
          id: expect.any(String),
          kind: 'oidc',
          issuer: mock.issuer,
          email: 'linked@example.com',
        },
      ]);
    });

    it('refuses a link whose ID token reports auth_time over 5 minutes old with reauth_required', async () => {
      const u = await user({ wallet: true });
      const s = await startLink(u);
      mock.setClaims({ auth_time: Math.floor(Date.now() / 1000) - 301 });
      await failsWith(callback(s, [s.txCookie, u.cookie]), 'reauth_required');
      expect(await identities(u)).toHaveLength(1);
    });

    it.each([
      ['without auth_time (Google does not document it)', {}],
      ['with a recent auth_time', { auth_time: Math.floor(Date.now() / 1000) }],
    ])('links with an ID token %s', async (_, claims) => {
      const u = await user({ wallet: true });
      const s = await startLink(
        u,
        undefined,
        `${randomBytes(6).toString('hex')}@example.com`,
      );
      mock.setClaims(claims);
      const res = await callback(s, [s.txCookie, u.cookie]).expect(302);
      expect(res.headers.location).toBe(`${APP_URL}/settings`);
      expect(await identities(u)).toHaveLength(2);
    });

    async function countUsers(): Promise<number> {
      return (await t.sql.query(`SELECT count(*)::int AS n FROM users`))[0].n;
    }

    it('fails when another session of the same user completes the flow', async () => {
      const u = await user({ wallet: true });
      const other = await secondSession(u.userId);
      const s = await startLink(u);
      await failsWith(callback(s, [s.txCookie, other]), 'failed');
      expect(await identities(u)).toHaveLength(1);
    });

    it('fails when another browser completes the flow', async () => {
      const u = await user({ wallet: true });
      const victim = await startLink(u);
      const attacker = await startLink(u, undefined, 'attacker@example.com');
      // not bound to this browser: the default page, not the flow's returnTo
      await failsWith(
        callback(victim, [attacker.txCookie, u.cookie]),
        'failed',
        '/organizations',
      );
      // the state was consumed by the first attempt
      await failsWith(
        callback(victim, [u.cookie]),
        'expired',
        '/organizations',
      );
    });

    it('fails when the link flow is completed without a session', async () => {
      const u = await user({ wallet: true });
      const s = await startLink(u);
      await failsWith(callback(s, [s.txCookie]), 'failed');
    });

    it('redirects with identity_taken when the identity belongs to another user', async () => {
      // the mock derives the subject from the email: same email, same identity
      const email = 'taken@example.com';
      const owner = await user({ wallet: true });
      const s1 = await startLink(owner, undefined, email);
      await callback(s1, [s1.txCookie, owner.cookie]).expect(302);
      const u = await user({ wallet: true });
      const s2 = await startLink(u, undefined, email);
      await failsWith(callback(s2, [s2.txCookie, u.cookie]), 'identity_taken');
    });

    it('answers 403 on authorize without fresh strong auth', async () => {
      const u = await user({ wallet: true, strong: false });
      const res = await t
        .post('/v1/orgs/account/link/oidc/authorize')
        .set('Cookie', u.cookie)
        .send({})
        .expect(403);
      expect(res.body.code).toBe('step_up_required');
    });

    it('keeps sign-in callbacks working (no session id in the state)', async () => {
      const res = await t
        .http()
        .get('/v1/orgs/auth/oidc/authorize')
        .expect(302);
      const idp = await fetch(new URL(res.headers.location), {
        redirect: 'manual',
      });
      const back = new URL(idp.headers.get('location')!);
      const done = await callback(
        {
          txCookie: '',
          code: back.searchParams.get('code')!,
          state: back.searchParams.get('state')!,
        },
        [cookieFrom(res, '__Host-org_oidc_tx')],
      ).expect(302);
      expect(cookieFrom(done, '__Host-org_session')).toMatch(
        /^__Host-org_session=/,
      );
    });
  });

  describe('DELETE /v1/orgs/account/identities/:identityId', () => {
    const remove = (u: User, id: string): request.Test =>
      t.del(`/v1/orgs/account/identities/${id}`).set('Cookie', u.cookie);

    it('refuses to remove the last identity with 409 last_identity', async () => {
      const u = await user({ wallet: true });
      const [only] = await identities(u);
      const res = await remove(u, only.id as string).expect(409);
      expect(res.body).toEqual({
        statusCode: 409,
        message: expect.any(String),
        code: 'last_identity',
      });
    });

    it('removes an identity, revokes the other sessions and records the event', async () => {
      const u = await user({ wallet: true, email: true });
      const other = await secondSession(u.userId);
      const wallet = (await identities(u)).find((i) => i.kind === 'wallet')!;
      await remove(u, wallet.id as string).expect(204);
      expect(await identities(u)).toEqual([
        expect.objectContaining({ kind: 'oidc' }),
      ]);
      await t.http().get('/v1/orgs/auth/me').set('Cookie', other).expect(401);
      const events = await t.sql.query(
        `SELECT type, payload FROM user_security_events WHERE user_id = $1`,
        [u.userId],
      );
      expect(events).toEqual([
        { type: 'security.identity_removed', payload: { kind: 'wallet' } },
      ]);
    });

    it("answers 404 for another user's identity", async () => {
      const u = await user({ wallet: true, email: true });
      const stranger = await user({ wallet: true, email: true });
      const [theirs] = await identities(stranger);
      await remove(u, theirs.id as string).expect(404);
      expect(await identities(stranger)).toHaveLength(2);
    });

    it('requires fresh strong auth', async () => {
      const u = await user({ wallet: true, email: true, strong: false });
      const [first] = await identities(u);
      const res = await remove(u, first.id as string).expect(403);
      expect(res.body.code).toBe('step_up_required');
    });
  });

  it('GET /v1/orgs/auth/me identities carry id (A16)', async () => {
    const u = await user({ wallet: true, email: true });
    for (const identity of await identities(u)) {
      expect(identity.id).toMatch(/^[0-9a-f-]{36}$/);
    }
  });
});
