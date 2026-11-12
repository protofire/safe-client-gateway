import { randomBytes } from 'node:crypto';
import type request from 'supertest';
import { IConfigurationService } from '@/config/configuration.service.interface';
import { LoggingService } from '@/logging/logging.interface';
import { cookieFrom } from '@/modules/org/auth/__tests__/auth-test-app';
import { EmailOtpService } from '@/modules/org/auth/email-otp/email-otp.service';
import { EMAIL_OTP_ISSUER } from '@/modules/org/auth/oidc/oidc.service';
import { hmacEmail, sha256Hex } from '@/modules/org/crypto/hashing';
import {
  createOrgTestApp,
  type OrgTestApp,
} from '@/modules/org/orgs/__tests__/org-test-app';

jest.setTimeout(60_000);

const ALLOWED = 'allowed@example.com';
const TX_COOKIE = '__Host-org_email_tx';

type Helpers = {
  drain(): Promise<void>;
  /** Codes mailed to `to`, oldest first. */
  codeMails(to: string): Array<string>;
  start(
    email: string,
    ip?: string,
  ): Promise<{ res: request.Response; tx: string }>;
  verify(code: string, cookies: Array<string>): request.Test;
  emailKey(): Buffer;
  /** Lets the 1/min per-address limit pass again (the hour and day windows stay). */
  nextMinute(email: string): Promise<number>;
  wrongCode(code: string): string;
};

/** Helpers over one org test app (Resend stubbed: codes are read from the stub). */
function helpers(t: () => OrgTestApp): Helpers {
  const drain = (): Promise<void> => t().app.get(EmailOtpService).drain();
  const codeMails = (to: string): Array<string> =>
    t()
      .mailPost.mock.calls.map(
        ([a]) => a.data as { to: Array<string>; subject: string; text: string },
      )
      .filter((d) => d.to[0] === to && /sign-in code/.test(d.subject))
      .map((d) => /code is (\d{8})/.exec(String(d.text))![1]);

  const start = async (
    email: string,
    ip?: string,
  ): Promise<{ res: request.Response; tx: string }> => {
    let req = t().post('/v1/orgs/auth/email/start');
    if (ip) req = req.set('X-Forwarded-For', ip);
    const res = await req.send({ email });
    await drain();
    return {
      res,
      tx: res.status === 200 ? cookieFrom(res, TX_COOKIE) : '',
    };
  };
  const verify = (code: string, cookies: Array<string>): request.Test =>
    t()
      .post('/v1/orgs/auth/email/verify')
      .set('Cookie', cookies.join('; '))
      .send({ code });
  const emailKey = (): Buffer =>
    Buffer.from(
      t()
        .app.get<IConfigurationService>(IConfigurationService)
        .getOrThrow<string>('org.emailHashKey'),
      'base64',
    );
  const nextMinute = (email: string): Promise<number> =>
    t().redis.del(
      `${t().prefix}ratelimit:email-otp:send:email:${hmacEmail(email, emailKey())}:60`,
    );
  const wrongCode = (code: string): string =>
    ((Number(code) + 1) % 1e8).toString().padStart(8, '0');
  return { drain, codeMails, start, verify, emailKey, nextMinute, wrongCode };
}

describe('email one-time code, sign-up gated by ORG_CREATE_ALLOWLIST', () => {
  let t: OrgTestApp;
  const h = helpers(() => t);

  beforeAll(async () => {
    t = await createOrgTestApp(8, {
      'org.createAllowlist': { wallets: [], emails: [ALLOWED] },
    });
  });

  afterAll(async () => {
    await t?.close();
  });

  beforeEach(async () => {
    t.mailPost.mockClear();
    await t.reset();
  });

  const me = async (cookie: string): Promise<request.Response> =>
    t.http().get('/v1/orgs/auth/me').set('Cookie', cookie).expect(200);

  it('signs in with the mailed code: session not strong, identity under the email-otp issuer, tx cookie cleared, code single use', async () => {
    const { res, tx } = await h.start(' Allowed@Example.com ');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const cookie = [res.headers['set-cookie']]
      .flat()
      .find((c) => c.startsWith(`${TX_COOKIE}=`))!;
    expect(cookie).toMatch(/; Max-Age=600;/);
    expect(cookie).toMatch(/; Path=\/;/);
    expect(cookie).toMatch(/; HttpOnly/);
    expect(cookie).toMatch(/; Secure/);
    expect(cookie).not.toMatch(/; Domain=/i);

    const [code] = h.codeMails(ALLOWED);
    expect(code).toMatch(/^\d{8}$/);
    const mail = t.mailPost.mock.calls[0][0].data;
    expect(mail.text).toContain('We never ask for this code');
    expect(mail.text).not.toMatch(/https?:/);

    // stored as an HMAC, never the code, for at most 10 minutes
    const key = `${t.prefix}auth:email:tx:${sha256Hex(tx.split('=')[1])}`;
    const stored = (await t.redis.get(key))!;
    expect(stored).not.toContain(code);
    expect(stored).not.toContain(sha256Hex(code));
    expect(await t.redis.ttl(key)).toBeGreaterThan(590);

    const ok = await h.verify(code, [tx]).expect(200);
    expect(ok.body).toEqual({
      user: { id: expect.any(String) },
      linkHint: false,
    });
    expect(
      [ok.headers['set-cookie']].flat().find((c) => c.startsWith(TX_COOKIE)),
    ).toMatch(new RegExp(`^${TX_COOKIE}=;`));
    const session = cookieFrom(ok, '__Host-org_session');
    const body = (await me(session)).body;
    expect(body.identities).toEqual([
      {
        id: expect.any(String),
        kind: 'oidc',
        issuer: EMAIL_OTP_ISSUER,
        email: ALLOWED,
      },
    ]);
    expect(body.lastStrongAuthAt).toBeNull();
    const [row] = await t.sql.query(
      `SELECT s.amr, s.last_strong_auth_at, i.oidc_subject, i.email_hash
       FROM sessions s JOIN identities i ON i.user_id = s.user_id WHERE s.user_id = $1`,
      [ok.body.user.id],
    );
    expect(row.amr).toEqual(['email_otp']);
    expect(row.last_strong_auth_at).toBeNull();
    expect(row.oidc_subject).toBe(row.email_hash);
    expect(row.email_hash).toBe(hmacEmail(ALLOWED, h.emailKey()));

    // an email code never counts as strong auth
    const strong = await t
      .post('/v1/orgs/account/link/siwe')
      .set('Cookie', session)
      .send({ message: 'x', signature: '0x00' })
      .expect(403);
    expect(strong.body.code).toBe('totp_required');

    // single use
    const again = await h.verify(code, [tx]).expect(401);
    expect(again.body.code).toBe('code_invalid');

    // the next sign-in is the same user
    await h.nextMinute(ALLOWED);
    const second = await h.start(ALLOWED);
    const [, code2] = h.codeMails(ALLOWED);
    const res2 = await h.verify(code2, [second.tx]).expect(200);
    expect(res2.body.user.id).toBe(ok.body.user.id);
  });

  it('burns the code after 5 wrong attempts, counted before the comparison', async () => {
    const { tx } = await h.start(ALLOWED);
    const [code] = h.codeMails(ALLOWED);
    const wrong = await Promise.all(
      Array.from({ length: 5 }, () => h.verify(h.wrongCode(code), [tx])),
    );
    expect(wrong.map((r) => r.status)).toEqual([401, 401, 401, 401, 401]);
    const sixth = await h.verify(code, [tx]).expect(429);
    expect(sixth.body.code).toBe('too_many_attempts');
    expect(
      await t.redis.get(
        `${t.prefix}auth:email:tx:${sha256Hex(tx.split('=')[1])}`,
      ),
    ).toBeNull();
  });

  it("does not let an attacker's requests for the same address affect the victim's code, nor use it", async () => {
    const victim = await h.start(ALLOWED);
    const [victimCode] = h.codeMails(ALLOWED);
    await h.nextMinute(ALLOWED);
    const attacker = await h.start(ALLOWED);
    expect(h.codeMails(ALLOWED)).toHaveLength(2);
    // the victim's code in the attacker's browser
    await h.verify(victimCode, [attacker.tx]).expect(401);
    for (let i = 0; i < 4; i++) {
      await h.verify(h.wrongCode(victimCode), [attacker.tx]).expect(401);
    }
    await h.verify(victimCode, [attacker.tx]).expect(429);
    // no cookie at all
    await h.verify(victimCode, []).expect(401);
    await h.verify(victimCode, [victim.tx]).expect(200);
  });

  it('answers an unknown address exactly like a known one, and mails nothing to it', async () => {
    const known = await h.start(ALLOWED);
    const unknown = await h.start('stranger@example.com');
    const shape = (r: request.Response): unknown => ({
      status: r.status,
      body: r.body,
      cookies: [r.headers['set-cookie']]
        .flat()
        .map((c: string) => c.replace(/=[^;]*/, '=<v>')),
    });
    expect(shape(unknown.res)).toEqual(shape(known.res));
    expect(h.codeMails('stranger@example.com')).toEqual([]);
    expect(h.codeMails(ALLOWED)).toHaveLength(1);
    // verifying a guess for the unknown address looks like a wrong code
    const res = await h.verify('12345678', [unknown.tx]).expect(401);
    expect(res.body.code).toBe('code_invalid');
  });

  it('mails an address of an existing identity and of a pending invitation', async () => {
    const admin = await t.user({ wallet: true, email: ALLOWED });
    await h.start(ALLOWED);
    expect(h.codeMails(ALLOWED)).toHaveLength(1);

    const existing = 'Known.User@Example.com';
    await t.user({ email: existing });
    await h.start(existing);
    expect(h.codeMails('known.user@example.com')).toHaveLength(1);

    const invited = 'invited@example.com';
    await h.start(invited);
    expect(h.codeMails(invited)).toEqual([]);
    const orgId = await t.createOrg(admin);
    await t
      .post(`/v1/orgs/${orgId}/members/invite`)
      .set('Cookie', admin.cookie)
      .send({ email: invited })
      .expect(201);
    await h.nextMinute(invited);
    await h.start(invited);
    expect(h.codeMails(invited)).toHaveLength(1);
  });

  it('limits sends per address (1/min, 5/hour, 10/day) silently, and starts per IP with 429', async () => {
    await h.start(ALLOWED);
    const limited = await h.start(ALLOWED);
    expect(limited.res.status).toBe(200);
    expect(h.codeMails(ALLOWED)).toHaveLength(1);
    for (let i = 0; i < 6; i++) {
      await h.nextMinute(ALLOWED);
      await h.start(ALLOWED);
    }
    expect(h.codeMails(ALLOWED)).toHaveLength(5);
    // the hour window passes, the day window keeps counting
    const hash = hmacEmail(ALLOWED, h.emailKey());
    for (let i = 0; i < 7; i++) {
      await t.redis.del([
        `${t.prefix}ratelimit:email-otp:send:email:${hash}:60`,
        `${t.prefix}ratelimit:email-otp:send:email:${hash}:3600`,
      ]);
      await h.start(ALLOWED);
    }
    expect(h.codeMails(ALLOWED)).toHaveLength(10);

    const ip = `10.77.${randomBytes(1)[0]}.1`;
    const statuses: Array<number> = [];
    for (let i = 0; i < 11; i++) {
      statuses.push((await h.start(`ip${i}@example.com`, ip)).res.status);
    }
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(200));
    expect(statuses[10]).toBe(429);
  });

  it('expires the code with its record', async () => {
    const { tx } = await h.start(ALLOWED);
    const [code] = h.codeMails(ALLOWED);
    await t.redis.pExpire(
      `${t.prefix}auth:email:tx:${sha256Hex(tx.split('=')[1])}`,
      1,
    );
    await new Promise((r) => setTimeout(r, 20));
    const res = await h.verify(code, [tx]).expect(401);
    expect(res.body.code).toBe('code_invalid');
  });

  it('hints at linking when another user has this email under Google, and never merges', async () => {
    const email = 'hinted@example.com';
    const google = await t.user({ email });
    const { tx } = await h.start(email);
    const [code] = h.codeMails(email);
    const res = await h.verify(code, [tx]).expect(200);
    expect(res.body.linkHint).toBe(true);
    expect(res.body.user.id).not.toBe(google.userId);
    const ids = await t.sql.query(
      `SELECT user_id AS "userId" FROM identities WHERE email_hash = $1 ORDER BY created_at`,
      [hmacEmail(email, h.emailKey())],
    );
    expect(ids).toEqual([
      { userId: google.userId },
      { userId: res.body.user.id },
    ]);
  });

  describe('linking from Account settings', () => {
    const linkStart = (cookie: string, email: string): request.Test =>
      t
        .post('/v1/orgs/account/link/email/start')
        .set('Cookie', cookie)
        .send({ email });
    const linkVerify = (code: string, cookies: Array<string>): request.Test =>
      t
        .post('/v1/orgs/account/link/email/verify')
        .set('Cookie', cookies.join('; '))
        .send({ code });

    it('links an address outside the sign-in gate after fresh strong auth, and revokes other sessions', async () => {
      const u = await t.user({ wallet: true });
      const to = 'new.address@example.com';
      const started = await linkStart(u.cookie, to).expect(200);
      expect(started.body).toEqual({ ok: true });
      await h.drain();
      const [code] = h.codeMails(to);
      const tx = cookieFrom(started, TX_COOKIE);
      // not through the sign-in endpoint
      await h.verify(code, [tx]).expect(401);
      // the 401 above counted one attempt; the record is still there
      await linkVerify(code, [tx, u.cookie]).expect(200);
      const identities = (await me(u.cookie)).body.identities;
      expect(identities).toEqual([
        expect.objectContaining({ kind: 'wallet' }),
        {
          id: expect.any(String),
          kind: 'oidc',
          issuer: EMAIL_OTP_ISSUER,
          email: to,
        },
      ]);
      const [event] = await t.sql.query(
        `SELECT payload FROM user_security_events WHERE user_id = $1 AND type = 'security.identity_linked'`,
        [u.userId],
      );
      expect(event.payload).toEqual({ kind: 'email_otp' });
    });

    it('needs fresh strong auth to start', async () => {
      const u = await t.user({ wallet: true, strong: false });
      const res = await linkStart(u.cookie, 'x@example.com').expect(403);
      expect(res.body.code).toBe('step_up_required');
    });

    it("refuses the code from another session of the same user or another user's session", async () => {
      const u = await t.user({ wallet: true });
      const other = await t.user({ wallet: true });
      const to = 'bound@example.com';
      const started = await linkStart(u.cookie, to).expect(200);
      await h.drain();
      const [code] = h.codeMails(to);
      const tx = cookieFrom(started, TX_COOKIE);
      await linkVerify(code, [tx, other.cookie]).expect(401);
      await linkVerify(code, [tx]).expect(401);
      await linkVerify(code, [tx, u.cookie]).expect(200);
    });

    it("answers 409 identity_taken for an address that is another user's email-code identity", async () => {
      const { tx } = await h.start(ALLOWED);
      await h.verify(h.codeMails(ALLOWED)[0], [tx]).expect(200);
      const u = await t.user({ wallet: true });
      const started = await linkStart(u.cookie, ALLOWED).expect(200);
      await h.drain();
      expect(h.codeMails(ALLOWED)).toHaveLength(1); // 1/min per address
      await h.nextMinute(ALLOWED);
      const again = await linkStart(u.cookie, ALLOWED).expect(200);
      await h.drain();
      const res = await linkVerify(h.codeMails(ALLOWED)[1], [
        cookieFrom(again, TX_COOKIE),
        u.cookie,
      ]).expect(409);
      expect(res.body.code).toBe('identity_taken');
      expect(started.status).toBe(200);
    });
  });
});

describe('email one-time code, open sign-up', () => {
  let t: OrgTestApp;
  const h = helpers(() => t);

  beforeAll(async () => {
    t = await createOrgTestApp(9);
  });

  afterAll(async () => {
    await t?.close();
  });

  beforeEach(async () => {
    t.mailPost.mockClear();
    await t.reset();
  });

  it('mails any address', async () => {
    const { tx } = await h.start('anyone@example.com');
    const [code] = h.codeMails('anyone@example.com');
    await h.verify(code, [tx]).expect(200);
  });

  it('stops all sends over the global hourly breaker and logs an error, with the same answer', async () => {
    await t.redis.set(`${t.prefix}ratelimit:email-otp:send:global`, '200', {
      EX: 3600,
    });
    const logger = t.app.get<{ error: jest.Mock }>(LoggingService);
    logger.error.mockClear();
    const { res } = await h.start('breaker@example.com');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(h.codeMails('breaker@example.com')).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('ORG_EMAIL_OTP_MAX_SENDS_PER_HOUR'),
    );
  });

  it('rejects a malformed address or code with 422', async () => {
    await t
      .post('/v1/orgs/auth/email/start')
      .send({ email: 'not-an-email' })
      .expect(422);
    await t
      .post('/v1/orgs/auth/email/verify')
      .send({ code: '1234' })
      .expect(422);
  });
});
