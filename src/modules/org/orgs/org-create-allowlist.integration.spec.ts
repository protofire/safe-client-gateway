import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  createOrgTestApp,
  type OrgTestApp,
  type TestUser,
} from '@/modules/org/orgs/__tests__/org-test-app';

jest.setTimeout(60_000);

const ALLOWED_WALLET = privateKeyToAccount(generatePrivateKey()).address;
const ALLOWED_EMAIL = 'beta.tester@example.com';

describe('org creation beta allowlist (ORG_CREATE_ALLOWLIST)', () => {
  let t: OrgTestApp;

  beforeAll(async () => {
    // the parsed form org-configuration.ts produces: lowercase, split by kind
    t = await createOrgTestApp(7, {
      'org.createAllowlist': {
        wallets: [ALLOWED_WALLET.toLowerCase()],
        emails: [ALLOWED_EMAIL],
      },
    });
  });

  afterAll(async () => {
    await t?.close();
  });

  beforeEach(async () => {
    await t.reset();
  });

  const canCreate = async (user: TestUser): Promise<boolean> =>
    (
      await t
        .http()
        .get('/v1/orgs/auth/me')
        .set('Cookie', user.cookie)
        .expect(200)
    ).body.canCreateOrganization;

  it('lets a user whose wallet is listed create an org, in any address case', async () => {
    const user = await t.user({ wallet: true });
    // stored checksummed, listed lowercase
    await t.sql.query(
      `UPDATE identities SET wallet_address = $1 WHERE user_id = $2 AND kind = 'wallet'`,
      [ALLOWED_WALLET, user.userId],
    );

    expect(await canCreate(user)).toBe(true);
    await t.createOrg(user);
  });

  it('lets a user whose email identity is listed create an org', async () => {
    const user = await t.user({ email: 'Beta.Tester@example.com' });

    expect(await canCreate(user)).toBe(true);
    await t.createOrg(user);
  });

  it('refuses an unlisted user with 403 org_create_not_allowed and writes nothing', async () => {
    const user = await t.user({ wallet: true, email: 'other@example.com' });

    expect(await canCreate(user)).toBe(false);
    const [{ orgsBefore }] = await t.sql.query(
      `SELECT count(*)::int AS "orgsBefore" FROM organizations`,
    );
    const res = await t
      .post('/v1/orgs')
      .set('Cookie', user.cookie)
      .send({ name: 'Acme' })
      .expect(403);

    expect(res.body).toEqual({
      statusCode: 403,
      code: 'org_create_not_allowed',
      message:
        'Creating organizations is limited during the beta. Ask an existing organization to invite you, or contact Protofire to get access.',
    });
    const [after] = await t.sql.query(
      `SELECT (SELECT count(*)::int FROM organizations) AS orgs,
         (SELECT count(*)::int FROM members WHERE user_id = $1) AS members,
         (SELECT count(*)::int FROM activity_events WHERE actor_user_id = $1) AS events`,
      [user.userId],
    );
    expect(after).toEqual({ orgs: orgsBefore, members: 0, events: 0 });
  });

  it('lets an unlisted user accept an email invitation and use the org', async () => {
    // the wallet makes the admin's session strong for the invite
    const admin = await t.user({ wallet: true, email: ALLOWED_EMAIL });
    const orgId = await t.createOrg(admin);
    const to = 'invitee@example.com';
    await t
      .post(`/v1/orgs/${orgId}/members/invite`)
      .set('Cookie', admin.cookie)
      .send({ email: to })
      .expect(201);
    const invitee = await t.user({ email: to });

    await t
      .post('/v1/orgs/invitations/accept')
      .set('Cookie', invitee.cookie)
      .send({ token: t.lastInviteToken(to) })
      .expect(200);

    expect(await canCreate(invitee)).toBe(false);
    await t
      .http()
      .get(`/v1/orgs/${orgId}`)
      .set('Cookie', invitee.cookie)
      .expect(200);
  });
});
