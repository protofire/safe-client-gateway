import { totpCode } from '@/modules/org/auth/__tests__/auth-test-app';
import { sha256Hex } from '@/modules/org/crypto/hashing';
import {
  createOrgTestApp,
  TEST_TOTP_SECRET,
  type OrgTestApp,
  type TestUser,
} from '@/modules/org/orgs/__tests__/org-test-app';

jest.setTimeout(60_000);

describe('account deletion (org)', () => {
  let t: OrgTestApp;

  beforeAll(async () => {
    t = await createOrgTestApp(5);
  });

  afterAll(async () => {
    await t?.close();
  });

  beforeEach(async () => {
    await t.reset();
  });

  const deleteAccount = (user: TestUser): ReturnType<OrgTestApp['del']> =>
    t.del('/v1/orgs/account').set('Cookie', user.cookie);

  async function twoAdmins(): Promise<{
    orgId: string;
    a: TestUser;
    b: TestUser;
  }> {
    const a = await t.user({ wallet: true });
    const b = await t.user({ wallet: true });
    const orgId = await t.createOrg(a);
    await t.addMember(orgId, b, 'admin');
    return { orgId, a, b };
  }

  it('deletes identities, factors, sessions and memberships, keeping the user row', async () => {
    const { orgId, b } = await twoAdmins();
    await t.sql.query(
      `INSERT INTO factors (user_id, kind, secret_encrypted, confirmed_at) VALUES ($1, 'totp', 'x', now())`,
      [b.userId],
    );
    await t.sql.query(
      `INSERT INTO recovery_codes (user_id, code_hash) VALUES ($1, $2)`,
      [b.userId, sha256Hex('aaaaabbbbbcccccddddd')],
    );

    await deleteAccount(b)
      .send({ recoveryCode: 'aaaaa-bbbbb-ccccc-ddddd' })
      .expect(204);

    for (const table of [
      'identities',
      'factors',
      'recovery_codes',
      'sessions',
      'members',
    ]) {
      expect(
        await t.sql.query(`SELECT 1 FROM ${table} WHERE user_id = $1`, [
          b.userId,
        ]),
      ).toEqual([]);
    }
    const [user] = await t.sql.query(`SELECT status FROM users WHERE id = $1`, [
      b.userId,
    ]);
    expect(user.status).toBe('deleted');
    await t.http().get('/v1/orgs/auth/me').set('Cookie', b.cookie).expect(401);
    expect(await t.adminCount(orgId)).toBe(1);
  });

  it('requires fresh strong auth', async () => {
    const user = await t.user({ wallet: true, strong: false });

    const res = await deleteAccount(user).expect(403);

    expect(res.body.code).toBe('step_up_required');
  });

  it('asks a user with TOTP for a current code or recovery code as well (403 totp_code_required, 401 wrong)', async () => {
    const user = await t.user({ email: 'totp-del@example.com', totp: true });

    const missing = await deleteAccount(user).expect(403);
    expect(missing.body.code).toBe('totp_code_required');
    const right = totpCode(TEST_TOTP_SECRET, new Date());
    await deleteAccount(user)
      .send({ code: right === '000000' ? '111111' : '000000' })
      .expect(401);
    await t
      .http()
      .get('/v1/orgs/auth/me')
      .set('Cookie', user.cookie)
      .expect(200);

    await deleteAccount(user).send({ code: right }).expect(204);
    const [row] = await t.sql.query(`SELECT status FROM users WHERE id = $1`, [
      user.userId,
    ]);
    expect(row.status).toBe('deleted');
  });

  it('blocks the last admin from deleting their account', async () => {
    const admin = await t.user({ wallet: true });
    const member = await t.user({ wallet: true });
    const orgId = await t.createOrg(admin);
    await t.addMember(orgId, member, 'member');

    const res = await deleteAccount(admin).expect(409);

    expect(res.body).toEqual({
      statusCode: 409,
      message: expect.any(String),
      code: 'last_admin',
    });
    await t
      .http()
      .get('/v1/orgs/auth/me')
      .set('Cookie', admin.cookie)
      .expect(200);
  });

  it('answers one 409 when two admins delete their accounts concurrently', async () => {
    const { orgId, a, b } = await twoAdmins();

    const statuses = (
      await Promise.all([deleteAccount(a), deleteAccount(b)])
    ).map((r) => r.status);

    expect(statuses.toSorted()).toEqual([204, 409]);
    expect(await t.adminCount(orgId)).toBe(1);
  });

  it('keeps an admin when account deletion races a leave', async () => {
    const { orgId, a, b } = await twoAdmins();

    const [deleted, left] = await Promise.all([
      deleteAccount(a),
      t.post(`/v1/orgs/${orgId}/members/leave`).set('Cookie', b.cookie),
    ]);

    expect([deleted.status, left.status].toSorted()).toEqual([204, 409]);
    expect(await t.adminCount(orgId)).toBe(1);
  });

  it('renders a deleted user as actorUserId null without ip in the activity log', async () => {
    const { orgId, a, b } = await twoAdmins();
    await t
      .patch(`/v1/orgs/${orgId}`)
      .set('Cookie', b.cookie)
      .set('User-Agent', 'b-agent')
      .send({ name: 'Renamed by b' })
      .expect(200);

    await deleteAccount(b).expect(204);

    const res = await t
      .http()
      .get(`/v1/orgs/${orgId}/activity?type=org.renamed`)
      .set('Cookie', a.cookie)
      .expect(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].actorUserId).toBeNull();
    expect(res.body.items[0]).not.toHaveProperty('ip');
    expect(res.body.items[0]).not.toHaveProperty('userAgent');
    const [row] = await t.sql.query(
      `SELECT actor_user_id AS "actorUserId", ip_encrypted AS ip, user_agent AS ua
       FROM activity_events WHERE org_id = $1 AND type = 'org.renamed'`,
      [orgId],
    );
    expect(row).toEqual({ actorUserId: b.userId, ip: null, ua: null });
  });

  describe('display name', () => {
    const setName = (user: TestUser, displayName: unknown): ReturnType<OrgTestApp['patch']> =>
      t.patch('/v1/orgs/account').set('Cookie', user.cookie).send({ displayName });

    it('sets a trimmed name, shows it in members, /auth/me and the activity actor, and clears it with null', async () => {
      const { orgId, a, b } = await twoAdmins();

      const res = await setName(b, '  Bob Builder ').expect(200);

      expect(res.body).toEqual({ displayName: 'Bob Builder' });
      const me = await t
        .http()
        .get('/v1/orgs/auth/me')
        .set('Cookie', b.cookie)
        .expect(200);
      expect(me.body.user).toEqual({ id: b.userId, displayName: 'Bob Builder' });
      const members = await t
        .http()
        .get(`/v1/orgs/${orgId}/members`)
        .set('Cookie', a.cookie)
        .expect(200);
      const named = (
        members.body as Array<{ userId: string; displayName: string | null }>
      ).map((m) => [m.userId, m.displayName]);
      expect(named).toEqual(
        expect.arrayContaining([
          [a.userId, null],
          [b.userId, 'Bob Builder'],
        ]),
      );
      const activity = await t
        .http()
        .get(`/v1/orgs/${orgId}/activity?type=security.display_name_changed`)
        .set('Cookie', a.cookie)
        .expect(200);
      expect(activity.body.items).toEqual([
        expect.objectContaining({
          actorUserId: b.userId,
          actorDisplayName: 'Bob Builder',
          payload: { cleared: false },
        }),
      ]);

      await setName(b, null).expect(200, { displayName: null });
      const [row] = await t.sql.query(
        `SELECT display_name FROM users WHERE id = $1`,
        [b.userId],
      );
      expect(row.display_name).toBeNull();
    });

    it.each([
      ['empty after trim', '   '],
      ['longer than 64', 'x'.repeat(65)],
      ['a control character', 'Bob\u0007'],
      ['not a string', 42],
    ])('rejects a name that is %s with 400', async (_, value) => {
      const user = await t.user({ wallet: true });
      await setName(user, value).expect(400);
    });

    it('needs no step-up and changes only the caller', async () => {
      const a = await t.user({ wallet: true, strong: false });
      const b = await t.user({ wallet: true });

      await setName(a, 'Alice').expect(200);

      const rows: Array<{ id: string; displayName: string | null }> =
        await t.sql.query(
          `SELECT id, display_name AS "displayName" FROM users WHERE id = ANY($1)`,
          [[a.userId, b.userId]],
        );
      expect(
        Object.fromEntries(rows.map((r) => [r.id, r.displayName])),
      ).toEqual({
        [a.userId]: 'Alice',
        [b.userId]: null,
      });
    });

    it('erases the name when the account is deleted', async () => {
      const { orgId, a, b } = await twoAdmins();
      await setName(b, 'Bob').expect(200);

      await deleteAccount(b).expect(204);

      const [row] = await t.sql.query(
        `SELECT display_name FROM users WHERE id = $1`,
        [b.userId],
      );
      expect(row.display_name).toBeNull();
      const activity = await t
        .http()
        .get(`/v1/orgs/${orgId}/activity?type=security.display_name_changed`)
        .set('Cookie', a.cookie)
        .expect(200);
      expect(activity.body.items[0]).toMatchObject({
        actorUserId: null,
        actorDisplayName: null,
      });
    });
  });
});
