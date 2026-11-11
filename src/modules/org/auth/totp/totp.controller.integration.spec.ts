import { createHmac, randomBytes } from 'node:crypto';
import type request from 'supertest';
import type { DataSource } from 'typeorm';
import { OrgTotpModule } from '@/modules/org/auth/totp/totp.module';
import {
  cookieFrom,
  createAuthTestApp,
  MINUTE,
  seedUser,
  type AuthTestApp,
} from '@/modules/org/auth/__tests__/auth-test-app';
import { SecurityEvents } from '@/modules/org/auth/security-events';
import { sha256Hex } from '@/modules/org/crypto/hashing';

// Independent RFC 6238 generator (SHA-1, 6 digits, 30 s), so the test does not trust totp.ts
function totpCode(secretBase32: string, at: Date): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secretBase32)
    bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at.getTime() / 30_000)));
  const mac = createHmac('sha1', key).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(
    6,
    '0',
  );
}

type Enrolled = {
  userId: string;
  cookie: string;
  secret: string;
  recoveryCodes: Array<string>;
};

/** Another active session of the same user, as from a second device. */
async function addSession(sql: DataSource, userId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await sql.query(
    `INSERT INTO sessions (user_id, token_hash, amr, expires_at, idle_expires_at)
     VALUES ($1, $2, '{oidc}', now() + interval '1 day', now() + interval '1 day')`,
    [userId, sha256Hex(token)],
  );
  return `__Host-org_session=${token}`;
}

describe('TOTP factors (org)', () => {
  let t: AuthTestApp;
  let offsetMs = 0;
  const at = (): Date => new Date(Date.now() + offsetMs);
  const shift = (ms: number): void => {
    offsetMs = ms;
    t.setOffset(ms);
  };

  beforeAll(async () => {
    t = await createAuthTestApp({ redisDb: 4, imports: [OrgTotpModule] });
  });

  afterAll(async () => {
    await t?.close();
  });

  beforeEach(async () => {
    offsetMs = 0;
    await t.reset();
  });

  /** Email-only user with confirmed TOTP; the session is strong right after confirm. */
  async function enrolled(): Promise<Enrolled> {
    const user = await seedUser(t.sql);
    const { body } = await t
      .post('/v1/orgs/auth/totp/enroll')
      .set('Cookie', user.cookie)
      .expect(200);
    const confirm = await t
      .post('/v1/orgs/auth/totp/confirm')
      .set('Cookie', user.cookie)
      .send({ code: totpCode(body.secret as string, at()) })
      .expect(200);
    // confirm rotates the session token (F2)
    return {
      ...user,
      cookie: cookieFrom(confirm, '__Host-org_session'),
      secret: body.secret,
      recoveryCodes: confirm.body.recoveryCodes,
    };
  }

  const me = async (
    cookie: string,
  ): Promise<{ hasTotp: boolean; lastStrongAuthAt: string | null }> =>
    (await t.http().get('/v1/orgs/auth/me').set('Cookie', cookie).expect(200))
      .body;

  it('lets an email-only user enrol without step-up; confirm makes the session strong (A17)', async () => {
    const user = await seedUser(t.sql);
    expect((await me(user.cookie)).lastStrongAuthAt).toBeNull();

    const res = await t
      .post('/v1/orgs/auth/totp/enroll')
      .set('Cookie', user.cookie)
      .expect(200);
    expect(res.body).toEqual({
      secret: expect.stringMatching(/^[A-Z2-7]{32}$/),
      otpauthUri: expect.stringMatching(/^otpauth:\/\/totp\//),
    });
    expect(res.body.otpauthUri).toContain(`secret=${res.body.secret}`);
    expect((await me(user.cookie)).hasTotp).toBe(false);

    const confirm = await t
      .post('/v1/orgs/auth/totp/confirm')
      .set('Cookie', user.cookie)
      .send({ code: totpCode(res.body.secret as string, at()) })
      .expect(200);
    const after = await me(cookieFrom(confirm, '__Host-org_session'));
    expect(after.hasTotp).toBe(true);
    expect(after.lastStrongAuthAt).not.toBeNull();
    const [session] = await t.sql.query(
      `SELECT amr FROM sessions WHERE user_id = $1`,
      [user.userId],
    );
    expect(session.amr).toEqual(['oidc', 'totp']);
  });

  it('rejects a wrong confirm code with 401 and keeps the factor unconfirmed', async () => {
    const user = await seedUser(t.sql);
    const { body } = await t
      .post('/v1/orgs/auth/totp/enroll')
      .set('Cookie', user.cookie)
      .expect(200);
    const wrong =
      totpCode(body.secret as string, at()) === '000000' ? '111111' : '000000';
    await t
      .post('/v1/orgs/auth/totp/confirm')
      .set('Cookie', user.cookie)
      .send({ code: wrong })
      .expect(401);
    expect((await me(user.cookie)).hasTotp).toBe(false);
  });

  it('answers 403 step_up_required to a wallet user enrolling without fresh SIWE', async () => {
    const stale = await seedUser(t.sql, {
      wallet: true,
      strongAt: new Date(Date.now() - 31 * MINUTE),
    });
    const res = await t
      .post('/v1/orgs/auth/totp/enroll')
      .set('Cookie', stale.cookie)
      .expect(403);
    expect(res.body).toEqual({
      statusCode: 403,
      message: expect.any(String),
      code: 'step_up_required',
      methods: ['siwe'],
    });

    const fresh = await seedUser(t.sql, { wallet: true, strongAt: new Date() });
    await t
      .post('/v1/orgs/auth/totp/enroll')
      .set('Cookie', fresh.cookie)
      .expect(200);
  });

  it('returns 10 recovery codes once and stores only their hashes', async () => {
    const user = await enrolled();
    expect(user.recoveryCodes).toHaveLength(10);
    expect(new Set(user.recoveryCodes).size).toBe(10);

    const rows: Array<{ code_hash: string }> = await t.sql.query(
      `SELECT code_hash FROM recovery_codes WHERE user_id = $1`,
      [user.userId],
    );
    expect(rows).toHaveLength(10);
    expect(rows.map((r) => r.code_hash)).not.toContain(user.recoveryCodes[0]);

    // a second enrolment or confirm cannot reveal codes again
    await t
      .post('/v1/orgs/auth/totp/enroll')
      .set('Cookie', user.cookie)
      .expect(409);
    await t
      .post('/v1/orgs/auth/totp/confirm')
      .set('Cookie', user.cookie)
      .send({ code: totpCode(user.secret, at()) })
      .expect(409);
  });

  it('accepts a recovery code once: two parallel uses give one 200 and one 401', async () => {
    const user = await enrolled();
    shift(31 * MINUTE);
    const use = (cookie = user.cookie): request.Test =>
      t
        .post('/v1/orgs/auth/step-up/totp')
        .set('Cookie', cookie)
        .send({ recoveryCode: user.recoveryCodes[3] });
    const results = await Promise.all([use(), use()]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
    const rotated = cookieFrom(
      results.find((r) => r.status === 200)!,
      '__Host-org_session',
    );
    await use(rotated).expect(401);

    const [row] = await t.sql.query(
      `SELECT used_at FROM recovery_codes WHERE user_id = $1 AND code_hash = $2`,
      [user.userId, sha256Hex(user.recoveryCodes[3].replace(/-/g, ''))],
    );
    expect(row.used_at).not.toBeNull();
    expect((await me(rotated)).lastStrongAuthAt).not.toBeNull();
  });

  it('accepts the same TOTP step once: two parallel step-ups give one 200 and one 401', async () => {
    const user = await enrolled();
    shift(31 * MINUTE);
    const code = totpCode(user.secret, at());
    const use = (): Promise<{ status: number }> =>
      t
        .post('/v1/orgs/auth/step-up/totp')
        .set('Cookie', user.cookie)
        .send({ code });
    const statuses = (await Promise.all([use(), use()]))
      .map((r) => r.status)
      .sort();
    expect(statuses).toEqual([200, 401]);
  });

  it('locks TOTP verification after 5 failures in 15 minutes (429), even for a right code', async () => {
    const user = await enrolled();
    const wrong = (): string =>
      totpCode(user.secret, at()) === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) {
      await t
        .post('/v1/orgs/auth/step-up/totp')
        .set('Cookie', user.cookie)
        .send({ code: wrong() })
        .expect(401);
    }
    shift(2 * MINUTE);
    const res = await t
      .post('/v1/orgs/auth/step-up/totp')
      .set('Cookie', user.cookie)
      .send({ code: totpCode(user.secret, at()) })
      .expect(429);
    expect(res.body).toEqual({ statusCode: 429, message: expect.any(String) });
    await t
      .post('/v1/orgs/auth/step-up/totp')
      .set('Cookie', user.cookie)
      .send({ recoveryCode: user.recoveryCodes[0] })
      .expect(429);
  });

  it('does not count successful verifications toward the lock', async () => {
    const user = await enrolled();
    let cookie = user.cookie;
    for (let i = 1; i <= 6; i++) {
      shift(i * MINUTE);
      const res = await t
        .post('/v1/orgs/auth/step-up/totp')
        .set('Cookie', cookie)
        .send({ code: totpCode(user.secret, at()) })
        .expect(200);
      cookie = cookieFrom(res, '__Host-org_session');
    }
  });

  it('answers 422 unless exactly one of code and recoveryCode is given', async () => {
    const user = await enrolled();
    await t
      .post('/v1/orgs/auth/step-up/totp')
      .set('Cookie', user.cookie)
      .send({})
      .expect(422);
    await t
      .post('/v1/orgs/auth/step-up/totp')
      .set('Cookie', user.cookie)
      .send({ code: '123456', recoveryCode: user.recoveryCodes[0] })
      .expect(422);
  });

  it('requires strong auth to DELETE totp and removes the factor and its recovery codes', async () => {
    const user = await enrolled();
    shift(31 * MINUTE);
    const denied = await t
      .del('/v1/orgs/auth/totp')
      .set('Cookie', user.cookie)
      .expect(403);
    expect(denied.body).toMatchObject({
      code: 'step_up_required',
      methods: ['totp'],
    });

    const stepUp = await t
      .post('/v1/orgs/auth/step-up/totp')
      .set('Cookie', user.cookie)
      .send({ code: totpCode(user.secret, at()) })
      .expect(200);
    const cookie = cookieFrom(stepUp, '__Host-org_session');
    await t.del('/v1/orgs/auth/totp').set('Cookie', cookie).expect(204);

    expect((await me(cookie)).hasTotp).toBe(false);
    const [{ n }] = await t.sql.query(
      `SELECT count(*)::int AS n FROM recovery_codes WHERE user_id = $1`,
      [user.userId],
    );
    expect(n).toBe(0);
    const events: Array<{ type: string; payload: unknown }> = await t.sql.query(
      `SELECT type, payload FROM user_security_events WHERE user_id = $1 ORDER BY created_at, type`,
      [user.userId],
    );
    expect(events).toEqual([
      { type: 'security.totp_enrolled', payload: {} },
      { type: 'security.step_up', payload: { method: 'totp' } },
      { type: 'security.totp_removed', payload: {} },
    ]);
  });

  it.each([
    ['code', (u: Enrolled): object => ({ code: totpCode(u.secret, at()) })],
    [
      'recovery code',
      (u: Enrolled): object => ({ recoveryCode: u.recoveryCodes[0] }),
    ],
  ])(
    'rotates the session on step-up with a %s: a copied pre-step-up cookie cannot pass a strong-auth route (F2)',
    async (_, proof) => {
      const user = await enrolled();
      const copy = user.cookie;
      shift(31 * MINUTE);
      const res = await t
        .post('/v1/orgs/auth/step-up/totp')
        .set('Cookie', user.cookie)
        .send(proof(user))
        .expect(200);
      expect(cookieFrom(res, '__Host-org_session')).not.toBe(copy);

      const denied = await t.del('/v1/orgs/auth/totp').set('Cookie', copy);
      expect([401, 403]).toContain(denied.status);
      expect((await me(cookieFrom(res, '__Host-org_session'))).hasTotp).toBe(
        true,
      );
    },
  );

  it('rotates the session on confirm: the pre-confirm cookie is dead (F2)', async () => {
    const user = await seedUser(t.sql);
    const { body } = await t
      .post('/v1/orgs/auth/totp/enroll')
      .set('Cookie', user.cookie)
      .expect(200);
    await t
      .post('/v1/orgs/auth/totp/confirm')
      .set('Cookie', user.cookie)
      .send({ code: totpCode(body.secret as string, at()) })
      .expect(200);
    await t
      .http()
      .get('/v1/orgs/auth/me')
      .set('Cookie', user.cookie)
      .expect(401);
  });

  it('revokes the other sessions of the user on TOTP confirm and delete; the current one keeps working (F3)', async () => {
    const user = await seedUser(t.sql);
    const other = await addSession(t.sql, user.userId);
    const { body } = await t
      .post('/v1/orgs/auth/totp/enroll')
      .set('Cookie', user.cookie)
      .expect(200);
    const confirm = await t
      .post('/v1/orgs/auth/totp/confirm')
      .set('Cookie', user.cookie)
      .send({ code: totpCode(body.secret as string, at()) })
      .expect(200);
    const current = cookieFrom(confirm, '__Host-org_session');
    await t.http().get('/v1/orgs/auth/me').set('Cookie', other).expect(401);

    const later = await addSession(t.sql, user.userId);
    await t.del('/v1/orgs/auth/totp').set('Cookie', current).expect(204);
    await t.http().get('/v1/orgs/auth/me').set('Cookie', later).expect(401);
    await t.http().get('/v1/orgs/auth/me').set('Cookie', current).expect(200);
  });

  it('commits nothing of a TOTP confirm or delete whose audit write fails (final gate F3)', async () => {
    const events = t.app.get(SecurityEvents);
    const user = await seedUser(t.sql);
    const { body } = await t
      .post('/v1/orgs/auth/totp/enroll')
      .set('Cookie', user.cookie)
      .expect(200);
    const failing = jest
      .spyOn(events, 'record')
      .mockRejectedValueOnce(new Error('audit down'));
    try {
      await t
        .post('/v1/orgs/auth/totp/confirm')
        .set('Cookie', user.cookie)
        .send({ code: totpCode(body.secret as string, at()) })
        .expect(500);
    } finally {
      failing.mockRestore();
    }
    // the old cookie still works: the session was not rotated either
    expect((await me(user.cookie)).hasTotp).toBe(false);
    const [{ n }] = await t.sql.query(
      `SELECT count(*)::int AS n FROM recovery_codes WHERE user_id = $1`,
      [user.userId],
    );
    expect(n).toBe(0);

    const enrolledUser = await enrolled();
    const failingRemove = jest
      .spyOn(events, 'record')
      .mockRejectedValueOnce(new Error('audit down'));
    try {
      await t
        .del('/v1/orgs/auth/totp')
        .set('Cookie', enrolledUser.cookie)
        .expect(500);
    } finally {
      failingRemove.mockRestore();
    }
    expect((await me(enrolledUser.cookie)).hasTotp).toBe(true);
  });
});
