import { randomBytes } from 'node:crypto';
import {
  createOrgTestApp,
  type OrgTestApp,
  type TestUser,
} from '@/modules/org/orgs/__tests__/org-test-app';

jest.setTimeout(60_000);


describe('members and invitations (org)', () => {
  let t: OrgTestApp;

  beforeAll(async () => {
    t = await createOrgTestApp(5);
  });

  afterAll(async () => {
    await t?.close();
  });

  beforeEach(async () => {
    await t.reset();
    t.mailPost.mockClear();
  });

  const email = (): string => `u${randomBytes(4).toString('hex')}@example.com`;

  async function inviteEmail(
    orgId: string,
    admin: TestUser,
    to: string,
    role = 'member',
  ): Promise<{ memberId: string; token: string }> {
    const res = await t
      .post(`/v1/orgs/${orgId}/members/invite`)
      .set('Cookie', admin.cookie)
      .send({ email: to, role })
      .expect(201);
    expect(res.body.emailSent).toBe(true);
    return { memberId: res.body.id, token: t.lastInviteToken(to) };
  }

  const accept = (user: TestUser, token: string): ReturnType<OrgTestApp['post']> =>
    t.post('/v1/orgs/invitations/accept').set('Cookie', user.cookie).send({ token });

  describe('email invitations', () => {
    it('mails the accept URL with the token in the fragment through Resend', async () => {
      const admin = await t.user({ wallet: true });
      const orgId = await t.createOrg(admin, 'Acme <b>');
      const to = email();

      await inviteEmail(orgId, admin, to);

      expect(t.mailPost).toHaveBeenCalledTimes(1);
      const [{ url, data, networkRequest }] = t.mailPost.mock.calls[0];
      expect(url).toBe('https://mail.example.com/emails');
      expect(networkRequest.headers.Authorization).toBe('Bearer test-mail-key');
      expect(data).toMatchObject({ from: 'noreply@example.com', to: [to] });
      expect(data.text).toMatch(
        /https:\/\/app\.example\.com\/organizations\/invite#token=[A-Za-z0-9_-]{43}/,
      );
      expect(data.html).toContain('Acme &lt;b&gt;');
      const [stored] = await t.sql.query(
        `SELECT token_hash, target_email_hash, expires_at FROM invitations WHERE org_id = $1`,
        [orgId],
      );
      const week = Date.now() + 7 * 24 * 3600 * 1000;
      expect(Math.abs(new Date(String(stored.expires_at)).getTime() - week)).toBeLessThan(60_000);
      expect(stored.token_hash).not.toContain(t.lastInviteToken(to));
      expect(stored.target_email_hash).not.toContain(to);
    });

    it('accepts an email invitation only with a verified OIDC identity of that email', async () => {
      const admin = await t.user({ wallet: true });
      const orgId = await t.createOrg(admin);
      const to = `alice.${randomBytes(3).toString('hex')}@example.com`;
      const { memberId, token } = await inviteEmail(orgId, admin, to);
      const wrong = await t.user({ wallet: true, email: email() });
      const invitee = await t.user({ email: to });

      const mismatch = await accept(wrong, token).expect(403);
      expect(mismatch.body).toEqual({
        statusCode: 403,
        message: expect.any(String),
        code: 'identity_mismatch',
        target: 'a***@example.com',
      });
      // invited, not active: every org resource is 404 (Review Focus 2)
      await t.http().get(`/v1/orgs/${orgId}`).set('Cookie', invitee.cookie).expect(404);

      const res = await accept(invitee, token).expect(200);
      expect(res.body).toEqual({ orgId });
      const [member] = await t.sql.query(
        `SELECT user_id AS "userId", status FROM members WHERE id = $1`,
        [memberId],
      );
      expect(member).toEqual({ userId: invitee.userId, status: 'active' });
      await t.http().get(`/v1/orgs/${orgId}`).set('Cookie', invitee.cookie).expect(200);
      const [joined] = await t.sql.query(
        `SELECT payload FROM activity_events WHERE org_id = $1 AND type = 'member.joined'`,
        [orgId],
      );
      expect(joined.payload).toEqual({ target: 'a***@example.com' });
    });

    it('rejects a second use and an expired invitation token', async () => {
      const admin = await t.user({ wallet: true });
      const orgId = await t.createOrg(admin);
      const to = email();
      const { token } = await inviteEmail(orgId, admin, to);
      const invitee = await t.user({ email: to });
      await accept(invitee, token).expect(200);

      const again = await accept(invitee, token).expect(404);
      expect(again.body.code).toBe('invitation_invalid');

      const to2 = email();
      const { memberId, token: old } = await inviteEmail(orgId, admin, to2);
      const late = await t.user({ email: to2 });
      // moved in the DB, not with the Clock: the invitee's session must stay valid
      await t.sql.query(
        `UPDATE invitations SET expires_at = now() - interval '1 second' WHERE member_id = $1`,
        [memberId],
      );
      const expired = await accept(late, old).expect(410);
      expect(expired.body.code).toBe('invitation_expired');
      await accept(late, 'x'.repeat(43)).expect(404);
    });

    it('lets exactly one of two parallel accepts win', async () => {
      const admin = await t.user({ wallet: true });
      const orgId = await t.createOrg(admin);
      const to = email();
      const { token } = await inviteEmail(orgId, admin, to);
      // two accounts holding the same verified email
      const a = await t.user({ email: to });
      const b = await t.user({ email: to });

      const statuses = (await Promise.all([accept(a, token), accept(b, token)])).map(
        (r) => r.status,
      );

      expect(statuses.toSorted()).toEqual([200, 404]);
      const [{ count }] = await t.sql.query(
        `SELECT count(*)::int AS count FROM members WHERE org_id = $1 AND status = 'active'`,
        [orgId],
      );
      expect(count).toBe(2);
    });

    it('renews an invitation with a new token; the old token stops working', async () => {
      const admin = await t.user({ wallet: true });
      const orgId = await t.createOrg(admin);
      const to = email();
      const { memberId, token: first } = await inviteEmail(orgId, admin, to);

      const res = await t
        .post(`/v1/orgs/${orgId}/members/${memberId}/invite/renew`)
        .set('Cookie', admin.cookie)
        .expect(200);
      expect(res.body).toEqual({ expiresAt: expect.any(String), emailSent: true });
      const second = t.lastInviteToken(to);
      expect(second).not.toBe(first);

      const invitee = await t.user({ email: to });
      await accept(invitee, first).expect(404);
      await accept(invitee, second).expect(200);
    });

    it('refuses a duplicate invitation and an invitation of an active member', async () => {
      const admin = await t.user({ wallet: true });
      const orgId = await t.createOrg(admin);
      const to = email();
      await inviteEmail(orgId, admin, to);

      const dup = await t
        .post(`/v1/orgs/${orgId}/members/invite`)
        .set('Cookie', admin.cookie)
        .send({ email: to.toUpperCase(), role: 'member' })
        .expect(409);
      expect(dup.body.code).toBe('already_invited');
      const self = await t
        .post(`/v1/orgs/${orgId}/members/invite`)
        .set('Cookie', admin.cookie)
        .send({ wallet: admin.wallet, role: 'member' })
        .expect(409);
      expect(self.body.code).toBe('already_member');
    });
  });

  describe('wallet invitations by org id', () => {
    it('lists, accepts and declines a wallet invitation without a token', async () => {
      const admin = await t.user({ wallet: true });
      const orgId = await t.createOrg(admin, 'Wallets');
      const joiner = await t.user({ wallet: true });
      const decliner = await t.user({ wallet: true });
      for (const u of [joiner, decliner]) {
        await t
          .post(`/v1/orgs/${orgId}/members/invite`)
          .set('Cookie', admin.cookie)
          .send({ wallet: u.wallet, role: 'member' })
          .expect(201);
      }
      expect(t.mailPost).not.toHaveBeenCalled();

      const listed = await t.http().get('/v1/orgs').set('Cookie', joiner.cookie).expect(200);
      expect(listed.body).toEqual([
        { id: orgId, name: 'Wallets', status: 'active', myStatus: 'invited' },
      ]);
      const outsider = await t.user({ wallet: true });
      await t.post(`/v1/orgs/${orgId}/members/accept`).set('Cookie', outsider.cookie).expect(404);

      await t.post(`/v1/orgs/${orgId}/members/accept`).set('Cookie', joiner.cookie).expect(200);
      await t.post(`/v1/orgs/${orgId}/members/decline`).set('Cookie', decliner.cookie).expect(200);

      const members = await t
        .http()
        .get(`/v1/orgs/${orgId}/members`)
        .set('Cookie', joiner.cookie)
        .expect(200);
      const byUser = Object.fromEntries(
        (members.body as Array<{ userId: string; status: string }>).map((m) => [
          m.userId,
          m.status,
        ]),
      );
      expect(byUser).toEqual({
        [admin.userId]: 'active',
        [joiner.userId]: 'active',
        [decliner.userId]: 'declined',
      });
      // declined: nothing of the org (Review Focus 2), and no longer listed
      await t.http().get(`/v1/orgs/${orgId}`).set('Cookie', decliner.cookie).expect(404);
      expect(
        (await t.http().get('/v1/orgs').set('Cookie', decliner.cookie).expect(200)).body,
      ).toEqual([]);
      await t.post(`/v1/orgs/${orgId}/members/accept`).set('Cookie', decliner.cookie).expect(404);

      // re-invite after decline reuses the member row
      await t
        .post(`/v1/orgs/${orgId}/members/invite`)
        .set('Cookie', admin.cookie)
        .send({ wallet: decliner.wallet, role: 'member' })
        .expect(201);
      await t.post(`/v1/orgs/${orgId}/members/accept`).set('Cookie', decliner.cookie).expect(200);
      const [{ count }] = await t.sql.query(
        `SELECT count(*)::int AS count FROM members WHERE org_id = $1 AND user_id = $2`,
        [orgId, decliner.userId],
      );
      expect(count).toBe(1);
    });
  });

  describe('members list', () => {
    it('shows identities, masking emails for members who are not admins or self', async () => {
      const adminEmail = `boss.${randomBytes(3).toString('hex')}@example.com`;
      const admin = await t.user({ email: adminEmail, totp: true });
      const orgId = await t.createOrg(admin);
      const member = await t.user({ wallet: true });
      await t.addMember(orgId, member, 'member');
      const invitedEmail = `carol.${randomBytes(3).toString('hex')}@example.com`;
      await inviteEmail(orgId, admin, invitedEmail);

      const asAdmin = (
        await t.http().get(`/v1/orgs/${orgId}/members`).set('Cookie', admin.cookie).expect(200)
      ).body;
      const asMember = (
        await t.http().get(`/v1/orgs/${orgId}/members`).set('Cookie', member.cookie).expect(200)
      ).body;

      expect(asAdmin).toEqual([
        {
          id: expect.any(String),
          userId: admin.userId,
          status: 'active',
          role: 'admin',
          identity: { kind: 'email', value: adminEmail },
        },
        {
          id: expect.any(String),
          userId: member.userId,
          status: 'active',
          role: 'member',
          identity: { kind: 'wallet', value: member.wallet },
        },
        {
          id: expect.any(String),
          userId: null,
          status: 'invited',
          role: 'member',
          identity: { kind: 'email', value: invitedEmail },
          invitedAt: expect.any(String),
          expiresAt: expect.any(String),
        },
      ]);
      expect((asMember as Array<{ identity: object }>).map((m) => m.identity)).toEqual([
        { kind: 'email', value: 'b***@example.com' },
        { kind: 'wallet', value: member.wallet },
        { kind: 'email', value: 'c***@example.com' },
      ]);
    });
  });

  it('limits an org to 100 members including invited, also under concurrent invites', async () => {
    const admin = await t.user({ wallet: true });
    const orgId = await t.createOrg(admin);
    // 1 admin + 97 invited = 98
    await t.sql.query(
      `INSERT INTO members (org_id, status) SELECT $1, 'invited' FROM generate_series(1, 97)`,
      [orgId],
    );

    const statuses = (
      await Promise.all(
        [1, 2, 3].map(() =>
          t
            .post(`/v1/orgs/${orgId}/members/invite`)
            .set('Cookie', admin.cookie)
            .send({ email: email(), role: 'member' }),
        ),
      )
    ).map((r) => r.status);

    expect(statuses.toSorted()).toEqual([201, 201, 409]);
    const [{ count }] = await t.sql.query(
      `SELECT count(*)::int AS count FROM members WHERE org_id = $1 AND status IN ('active', 'invited')`,
      [orgId],
    );
    expect(count).toBe(100);
  });

  describe('admin invariant (A4)', () => {
    async function twoAdmins(): Promise<{
      orgId: string;
      a: TestUser;
      b: TestUser;
      aId: string;
      bId: string;
    }> {
      const a = await t.user({ wallet: true });
      const b = await t.user({ wallet: true });
      const orgId = await t.createOrg(a);
      const bId = await t.addMember(orgId, b, 'admin');
      const [{ id: aId }] = await t.sql.query(
        `SELECT id FROM members WHERE org_id = $1 AND user_id = $2`,
        [orgId, a.userId],
      );
      return { orgId, a, b, aId, bId };
    }

    it('keeps one admin when two admins demote each other concurrently', async () => {
      const { orgId, a, b, aId, bId } = await twoAdmins();

      const results = await Promise.all([
        t.patch(`/v1/orgs/${orgId}/members/${bId}/role`).set('Cookie', a.cookie).send({ role: 'member' }),
        t.patch(`/v1/orgs/${orgId}/members/${aId}/role`).set('Cookie', b.cookie).send({ role: 'member' }),
      ]);

      expect(results.map((r) => r.status).toSorted()).toEqual([204, 409]);
      expect(results.find((r) => r.status === 409)!.body.code).toBe('last_admin');
      expect(await t.adminCount(orgId)).toBe(1);
    });

    it('answers 409 last_admin when the last admin demotes themself', async () => {
      const a = await t.user({ wallet: true });
      const orgId = await t.createOrg(a);
      const [{ id }] = await t.sql.query(`SELECT id FROM members WHERE org_id = $1`, [orgId]);

      const res = await t
        .patch(`/v1/orgs/${orgId}/members/${id}/role`)
        .set('Cookie', a.cookie)
        .send({ role: 'member' })
        .expect(409);

      expect(res.body).toEqual({
        statusCode: 409,
        message: expect.any(String),
        code: 'last_admin',
      });
    });

    it('blocks the last admin from leaving; another member can leave', async () => {
      const admin = await t.user({ wallet: true });
      const member = await t.user({ wallet: true });
      const orgId = await t.createOrg(admin);
      await t.addMember(orgId, member, 'member');

      const res = await t.post(`/v1/orgs/${orgId}/members/leave`).set('Cookie', admin.cookie).expect(409);
      expect(res.body.code).toBe('last_admin');
      await t.post(`/v1/orgs/${orgId}/members/leave`).set('Cookie', member.cookie).expect(204);
      await t.http().get(`/v1/orgs/${orgId}`).set('Cookie', member.cookie).expect(404);
    });

    it('removes a member with members.remove; a member cannot remove', async () => {
      const { orgId, a, b, bId } = await twoAdmins();
      const member = await t.user({ wallet: true });
      const memberId = await t.addMember(orgId, member, 'member');

      await t.del(`/v1/orgs/${orgId}/members/${bId}`).set('Cookie', member.cookie).expect(403);
      await t.del(`/v1/orgs/${orgId}/members/${memberId}`).set('Cookie', b.cookie).expect(204);
      await t.del(`/v1/orgs/${orgId}/members/${bId}`).set('Cookie', a.cookie).expect(204);
      expect(await t.adminCount(orgId)).toBe(1);
      await t.http().get(`/v1/orgs/${orgId}`).set('Cookie', member.cookie).expect(404);
    });
  });

  describe('factor reset (A8)', () => {
    it('resets factors and revokes all sessions of the target when the caller administers all its orgs', async () => {
      const admin = await t.user({ wallet: true });
      const target = await t.user({ email: email(), totp: true });
      const orgA = await t.createOrg(admin, 'A');
      const orgB = await t.createOrg(admin, 'B');
      const memberId = await t.addMember(orgA, target, 'member');
      await t.addMember(orgB, target, 'member');
      await t.sql.query(
        `INSERT INTO recovery_codes (user_id, code_hash) VALUES ($1, 'h')`,
        [target.userId],
      );
      await t.http().get('/v1/orgs/auth/me').set('Cookie', target.cookie).expect(200);

      await t
        .post(`/v1/orgs/${orgA}/members/${memberId}/factors/reset`)
        .set('Cookie', admin.cookie)
        .expect(204);

      for (const table of ['factors', 'recovery_codes']) {
        expect(
          await t.sql.query(`SELECT 1 FROM ${table} WHERE user_id = $1`, [target.userId]),
        ).toEqual([]);
      }
      await t.http().get('/v1/orgs/auth/me').set('Cookie', target.cookie).expect(401);
      await t.http().get('/v1/orgs/auth/me').set('Cookie', admin.cookie).expect(200);
      const rows: Array<{ type: string }> = await t.sql.query(
        `SELECT type FROM activity_events WHERE org_id = $1`,
        [orgA],
      );
      const types = rows.map((r) => r.type);
      expect(types).toEqual(
        expect.arrayContaining(['member.factors_reset', 'security.totp_removed']),
      );
    });

    it('answers 403 support_required when the target is in an org the caller does not administer', async () => {
      const admin = await t.user({ wallet: true });
      const otherAdmin = await t.user({ wallet: true });
      const target = await t.user({ email: email(), totp: true });
      const orgA = await t.createOrg(admin, 'A');
      const orgC = await t.createOrg(otherAdmin, 'C');
      const memberId = await t.addMember(orgA, target, 'member');
      await t.addMember(orgC, target, 'member');

      const res = await t
        .post(`/v1/orgs/${orgA}/members/${memberId}/factors/reset`)
        .set('Cookie', admin.cookie)
        .expect(403);

      expect(res.body.code).toBe('support_required');
      expect(
        await t.sql.query(`SELECT 1 FROM factors WHERE user_id = $1`, [target.userId]),
      ).toHaveLength(1);
      await t.http().get('/v1/orgs/auth/me').set('Cookie', target.cookie).expect(200);
    });
  });
});
