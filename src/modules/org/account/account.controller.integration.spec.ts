import {
  createOrgTestApp,
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

    await deleteAccount(b).expect(204);

    for (const table of ['identities', 'factors', 'sessions', 'members']) {
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
});
