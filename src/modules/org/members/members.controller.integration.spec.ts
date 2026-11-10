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
  ): Promise<{ memberId: string; token: string }> {
    const res = await t
      .post(`/v1/orgs/${orgId}/members/invite`)
      .set('Cookie', admin.cookie)
      .send({ email: to })
      .expect(201);
    expect(res.body.emailSent).toBe(true);
    return { memberId: res.body.id, token: t.lastInviteToken(to) };
  }

  const accept = (
    user: TestUser,
    token: string,
  ): ReturnType<OrgTestApp['post']> =>
    t
      .post('/v1/orgs/invitations/accept')
      .set('Cookie', user.cookie)
      .send({ token });

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
      expect(
        Math.abs(new Date(String(stored.expires_at)).getTime() - week),
      ).toBeLessThan(60_000);
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
      await t
        .http()
        .get(`/v1/orgs/${orgId}`)
        .set('Cookie', invitee.cookie)
        .expect(404);

      const res = await accept(invitee, token).expect(200);
      expect(res.body).toEqual({ orgId });
      const [member] = await t.sql.query(
        `SELECT user_id AS "userId", status FROM members WHERE id = $1`,
        [memberId],
      );
      expect(member).toEqual({ userId: invitee.userId, status: 'active' });
      await t
        .http()
        .get(`/v1/orgs/${orgId}`)
        .set('Cookie', invitee.cookie)
        .expect(200);
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

      const statuses = (
        await Promise.all([accept(a, token), accept(b, token)])
      ).map((r) => r.status);

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
      expect(res.body).toEqual({
        expiresAt: expect.any(String),
        emailSent: true,
      });
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

      const listed = await t
        .http()
        .get('/v1/orgs')
        .set('Cookie', joiner.cookie)
        .expect(200);
      expect(listed.body).toEqual([
        { id: orgId, name: 'Wallets', status: 'active', myStatus: 'invited' },
      ]);
      const outsider = await t.user({ wallet: true });
      await t
        .post(`/v1/orgs/${orgId}/members/accept`)
        .set('Cookie', outsider.cookie)
        .expect(404);

      await t
        .post(`/v1/orgs/${orgId}/members/accept`)
        .set('Cookie', joiner.cookie)
        .expect(200);
      await t
        .post(`/v1/orgs/${orgId}/members/decline`)
        .set('Cookie', decliner.cookie)
        .expect(200);

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
      await t
        .http()
        .get(`/v1/orgs/${orgId}`)
        .set('Cookie', decliner.cookie)
        .expect(404);
      expect(
        (
          await t
            .http()
            .get('/v1/orgs')
            .set('Cookie', decliner.cookie)
            .expect(200)
        ).body,
      ).toEqual([]);
      await t
        .post(`/v1/orgs/${orgId}/members/accept`)
        .set('Cookie', decliner.cookie)
        .expect(404);

      // re-invite after decline reuses the member row
      await t
        .post(`/v1/orgs/${orgId}/members/invite`)
        .set('Cookie', admin.cookie)
        .send({ wallet: decliner.wallet, role: 'member' })
        .expect(201);
      await t
        .post(`/v1/orgs/${orgId}/members/accept`)
        .set('Cookie', decliner.cookie)
        .expect(200);
      const [{ count }] = await t.sql.query(
        `SELECT count(*)::int AS count FROM members WHERE org_id = $1 AND user_id = $2`,
        [orgId, decliner.userId],
      );
      expect(count).toBe(1);
    });
  });

  describe('gate B fixes', () => {
    it('completes 15 parallel leaves on a small pool without hanging (F1)', async () => {
      const admin = await t.user({ wallet: true });
      const orgId = await t.createOrg(admin);
      const members: Array<TestUser> = [];
      for (let i = 0; i < 15; i++) {
        const m = await t.user({ wallet: true });
        await t.addMember(orgId, m, 'member');
        members.push(m);
      }

      const statuses = (
        await Promise.all(
          members.map((m) =>
            t.post(`/v1/orgs/${orgId}/members/leave`).set('Cookie', m.cookie),
          ),
        )
      ).map((r) => r.status);

      expect(statuses.filter((s) => s !== 204 && s !== 409)).toEqual([]);
      const [{ count }] = await t.sql.query(
        `SELECT count(*)::int AS count FROM members WHERE org_id = $1`,
        [orgId],
      );
      expect(count).toBe(1);
    });

    it('refuses an accept whose user was deleted while it waited on the org lock (F2)', async () => {
      const admin = await t.user({ wallet: true });
      const orgId = await t.createOrg(admin);
      const invitee = await t.user({ wallet: true });
      await t
        .post(`/v1/orgs/${orgId}/members/invite`)
        .set('Cookie', admin.cookie)
        .send({ wallet: invitee.wallet })
        .expect(201);
      const lock = await t.holdOrgLock(orgId);
      let pending: Promise<{ status: number }> | undefined;
      try {
        pending = t
          .post(`/v1/orgs/${orgId}/members/accept`)
          .set('Cookie', invitee.cookie)
          .then((r) => r);
        await lock.blocked();
      } finally {
        await lock.release(async (q) => {
          await q.query(`UPDATE users SET status = 'deleted' WHERE id = $1`, [
            invitee.userId,
          ]);
        });
      }

      expect((await pending).status).toBe(401);
      expect(
        await t.sql.query(
          `SELECT 1 FROM members WHERE org_id = $1 AND user_id = $2 AND status = 'active'`,
          [orgId, invitee.userId],
        ),
      ).toEqual([]);
    });

    it('does not count an admin whose user is deleted (F2 trigger)', async () => {
      const a = await t.user({ wallet: true });
      const ghost = await t.user({ wallet: true });
      const orgId = await t.createOrg(a);
      await t.addMember(orgId, ghost, 'admin');
      await t.sql.query(`UPDATE users SET status = 'deleted' WHERE id = $1`, [
        ghost.userId,
      ]);
      const [{ id }] = await t.sql.query(
        `SELECT id FROM members WHERE org_id = $1 AND user_id = $2`,
        [orgId, a.userId],
      );

      const res = await t
        .patch(`/v1/orgs/${orgId}/members/${id}/role`)
        .set('Cookie', a.cookie)
        .send({ role: 'member' })
        .expect(409);

      expect(res.body.code).toBe('last_admin');
    });

    it('accepts by org id only wallet invitations; email ones need the token (F5)', async () => {
      const admin = await t.user({ wallet: true });
      const orgId = await t.createOrg(admin);
      const to = email();
      const { token } = await inviteEmail(orgId, admin, to);
      const invitee = await t.user({ email: to });

      expect(
        (
          await t
            .http()
            .get('/v1/orgs')
            .set('Cookie', invitee.cookie)
            .expect(200)
        ).body,
      ).toEqual([]);
      await t
        .post(`/v1/orgs/${orgId}/members/accept`)
        .set('Cookie', invitee.cookie)
        .expect(404);
      await t
        .post(`/v1/orgs/${orgId}/members/decline`)
        .set('Cookie', invitee.cookie)
        .expect(404);
      await accept(invitee, token).expect(200);
    });
  });

  describe('final gate fixes', () => {
    it('refuses a token rotated by a renew committed between lookup and claim (F2)', async () => {
      const admin = await t.user({ wallet: true });
      const orgId = await t.createOrg(admin);
      const to = email();
      const { memberId, token } = await inviteEmail(orgId, admin, to);
      const invitee = await t.user({ email: to });

      // the accept has looked the token up and now waits on the org lock;
      // the renew's rotation commits before it may claim
      const lock = await t.holdOrgLock(orgId);
      let pending: Promise<{ status: number }> | undefined;
      try {
        pending = accept(invitee, token).then((r) => r);
        await lock.blocked();
      } finally {
        await lock.release(async (q) => {
          await q.query(
            `UPDATE invitations SET token_hash = $2 WHERE member_id = $1`,
            [memberId, randomBytes(32).toString('hex')],
          );
        });
      }

      expect((await pending).status).toBe(404);
      const [member] = await t.sql.query(
        `SELECT status FROM members WHERE id = $1`,
        [memberId],
      );
      expect(member.status).toBe('invited');
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
        await t
          .http()
          .get(`/v1/orgs/${orgId}/members`)
          .set('Cookie', admin.cookie)
          .expect(200)
      ).body;
      const asMember = (
        await t
          .http()
          .get(`/v1/orgs/${orgId}/members`)
          .set('Cookie', member.cookie)
          .expect(200)
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
      expect(
        (asMember as Array<{ identity: object }>).map((m) => m.identity),
      ).toEqual([
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
        t
          .patch(`/v1/orgs/${orgId}/members/${bId}/role`)
          .set('Cookie', a.cookie)
          .send({ role: 'member' }),
        t
          .patch(`/v1/orgs/${orgId}/members/${aId}/role`)
          .set('Cookie', b.cookie)
          .send({ role: 'member' }),
      ]);

      expect(results.map((r) => r.status).toSorted()).toEqual([204, 409]);
      expect(results.find((r) => r.status === 409)!.body.code).toBe(
        'last_admin',
      );
      expect(await t.adminCount(orgId)).toBe(1);
    });

    it('answers 409 last_admin when the last admin demotes themself', async () => {
      const a = await t.user({ wallet: true });
      const orgId = await t.createOrg(a);
      const [{ id }] = await t.sql.query(
        `SELECT id FROM members WHERE org_id = $1`,
        [orgId],
      );

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

      const res = await t
        .post(`/v1/orgs/${orgId}/members/leave`)
        .set('Cookie', admin.cookie)
        .expect(409);
      expect(res.body.code).toBe('last_admin');
      await t
        .post(`/v1/orgs/${orgId}/members/leave`)
        .set('Cookie', member.cookie)
        .expect(204);
      await t
        .http()
        .get(`/v1/orgs/${orgId}`)
        .set('Cookie', member.cookie)
        .expect(404);
    });

    it('removes a member with members.remove; a member cannot remove', async () => {
      const { orgId, a, b, bId } = await twoAdmins();
      const member = await t.user({ wallet: true });
      const memberId = await t.addMember(orgId, member, 'member');

      await t
        .del(`/v1/orgs/${orgId}/members/${bId}`)
        .set('Cookie', member.cookie)
        .expect(403);
      await t
        .del(`/v1/orgs/${orgId}/members/${memberId}`)
        .set('Cookie', b.cookie)
        .expect(204);
      await t
        .del(`/v1/orgs/${orgId}/members/${bId}`)
        .set('Cookie', a.cookie)
        .expect(204);
      expect(await t.adminCount(orgId)).toBe(1);
      await t
        .http()
        .get(`/v1/orgs/${orgId}`)
        .set('Cookie', member.cookie)
        .expect(404);
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
      await t
        .http()
        .get('/v1/orgs/auth/me')
        .set('Cookie', target.cookie)
        .expect(200);

      await t
        .post(`/v1/orgs/${orgA}/members/${memberId}/factors/reset`)
        .set('Cookie', admin.cookie)
        .expect(204);

      for (const table of ['factors', 'recovery_codes']) {
        expect(
          await t.sql.query(`SELECT 1 FROM ${table} WHERE user_id = $1`, [
            target.userId,
          ]),
        ).toEqual([]);
      }
      await t
        .http()
        .get('/v1/orgs/auth/me')
        .set('Cookie', target.cookie)
        .expect(401);
      await t
        .http()
        .get('/v1/orgs/auth/me')
        .set('Cookie', admin.cookie)
        .expect(200);
      const rows: Array<{ type: string }> = await t.sql.query(
        `SELECT type FROM activity_events WHERE org_id = $1`,
        [orgA],
      );
      const types = rows.map((r) => r.type);
      expect(types).toEqual(
        expect.arrayContaining([
          'member.factors_reset',
          'security.totp_removed',
        ]),
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
        await t.sql.query(`SELECT 1 FROM factors WHERE user_id = $1`, [
          target.userId,
        ]),
      ).toHaveLength(1);
      await t
        .http()
        .get('/v1/orgs/auth/me')
        .set('Cookie', target.cookie)
        .expect(200);
    });
  });

  describe('review fixes 2026-11-10', () => {
    /** Resend calls whose subject matches, as { to, subject, text }. */
    const mails = (
      subject: RegExp,
    ): Array<{ to: string; subject: string; text: string }> =>
      t.mailPost.mock.calls
        .map(
          ([args]) =>
            args.data as { to: Array<string>; subject: string; text: string },
        )
        .filter((d) => subject.test(d.subject))
        .map((d) => ({ to: d.to[0], subject: d.subject, text: d.text }));

    async function memberIdOf(orgId: string, u: TestUser): Promise<string> {
      const [{ id }] = await t.sql.query(
        `SELECT id FROM members WHERE org_id = $1 AND user_id = $2`,
        [orgId, u.userId],
      );
      return id;
    }

    it('invites as member only: 400 for role admin, role may be omitted or member (item 1)', async () => {
      const admin = await t.user({ wallet: true });
      const orgId = await t.createOrg(admin);
      const invitee = await t.user({ wallet: true });

      await t
        .post(`/v1/orgs/${orgId}/members/invite`)
        .set('Cookie', admin.cookie)
        .send({ wallet: invitee.wallet, role: 'admin' })
        .expect(400);
      const res = await t
        .post(`/v1/orgs/${orgId}/members/invite`)
        .set('Cookie', admin.cookie)
        .send({ wallet: invitee.wallet })
        .expect(201);
      expect(res.body.role).toBe('member');
      await t
        .post(`/v1/orgs/${orgId}/members/invite`)
        .set('Cookie', admin.cookie)
        .send({ email: email(), role: 'member' })
        .expect(201);
      await t
        .post(`/v1/orgs/${orgId}/members/accept`)
        .set('Cookie', invitee.cookie)
        .expect(200);
      expect(await t.adminCount(orgId)).toBe(1);
    });

    it.each(['removed', 'demoted', 'left', 'account_deleted'] as const)(
      'deletes the pending invitations of an admin who is %s (item 11, round 2 item 3)',
      async (how) => {
        const a = await t.user({ wallet: true });
        const b = await t.user({ wallet: true });
        const orgId = await t.createOrg(a);
        const bId = await t.addMember(orgId, b, 'admin');
        const byB = await inviteEmail(orgId, b, email());
        const byA = await inviteEmail(orgId, a, email());

        if (how === 'removed') {
          await t
            .del(`/v1/orgs/${orgId}/members/${bId}`)
            .set('Cookie', a.cookie)
            .expect(204);
        } else if (how === 'demoted') {
          await t
            .patch(`/v1/orgs/${orgId}/members/${bId}/role`)
            .set('Cookie', a.cookie)
            .send({ role: 'member' })
            .expect(204);
        } else if (how === 'left') {
          await t
            .post(`/v1/orgs/${orgId}/members/leave`)
            .set('Cookie', b.cookie)
            .expect(204);
        } else {
          await t.del('/v1/orgs/account').set('Cookie', b.cookie).expect(204);
        }

        const pending: Array<{ id: string }> = await t.sql.query(
          `SELECT m.id FROM members m WHERE m.org_id = $1 AND m.status = 'invited'`,
          [orgId],
        );
        expect(pending.map((r) => r.id)).toEqual([byA.memberId]);
        await accept(await t.user({ wallet: true }), byB.token).expect(404);
        const [revoked] = await t.sql.query(
          `SELECT payload FROM activity_events WHERE org_id = $1 AND type = 'member.invite_revoked'`,
          [orgId],
        );
        expect(revoked.payload).toEqual({
          target: expect.stringContaining('***'),
          reason: {
            removed: 'inviter_removed',
            demoted: 'inviter_demoted',
            left: 'inviter_left',
            account_deleted: 'inviter_left',
          }[how],
        });
      },
    );

    it('limits invitations to 60 per hour per inviting user across orgs, besides 30 per org (item 7)', async () => {
      const admin = await t.user({ wallet: true });
      const orgs = [
        await t.createOrg(admin, 'A'),
        await t.createOrg(admin, 'B'),
        await t.createOrg(admin, 'C'),
      ];
      const invite = (orgId: string): ReturnType<OrgTestApp['post']> =>
        t
          .post(`/v1/orgs/${orgId}/members/invite`)
          .set('Cookie', admin.cookie)
          .send({ email: email() });
      for (let i = 0; i < 30; i++) await invite(orgs[0]).expect(201);
      await invite(orgs[0]).expect(429); // per org
      for (let i = 0; i < 29; i++) await invite(orgs[1]).expect(201);
      // 61st attempt of this user: per user, although org C is untouched
      await invite(orgs[2]).expect(429);
      // refused per user before org C's counter is charged (round 2 item 11)
      for (let i = 0; i < 4; i++) await invite(orgs[2]).expect(429);
      // so another admin of org C still has all 30 of the org's invitations
      const other = await t.user({ wallet: true });
      await t.addMember(orgs[2], other, 'admin');
      const inviteAsOther = (): ReturnType<OrgTestApp['post']> =>
        t
          .post(`/v1/orgs/${orgs[2]}/members/invite`)
          .set('Cookie', other.cookie)
          .send({ email: email() });
      for (let i = 0; i < 30; i++) await inviteAsOther().expect(201);
      await inviteAsOther().expect(429);
    });

    describe('security notification mails (item 2)', () => {
      it('mails the remaining admins and the removed admin when an admin is removed', async () => {
        const aEmail = email();
        const bEmail = email();
        const a = await t.user({ email: aEmail, totp: true });
        const b = await t.user({ email: bEmail, totp: true });
        const walletAdmin = await t.user({ wallet: true });
        const orgId = await t.createOrg(a, 'Acme');
        await t.addMember(orgId, walletAdmin, 'admin');
        const bId = await t.addMember(orgId, b, 'admin');

        await t
          .del(`/v1/orgs/${orgId}/members/${bId}`)
          .set('Cookie', a.cookie)
          .expect(204);

        const sent = mails(/admin was removed/i);
        expect(sent.map((m) => m.to).toSorted()).toEqual(
          [aEmail, bEmail].toSorted(),
        );
        expect(sent[0].text).toContain('Acme');
      });

      it('does not mail when a plain member is removed', async () => {
        const a = await t.user({ email: email(), totp: true });
        const m = await t.user({ email: email() });
        const orgId = await t.createOrg(a);
        const mId = await t.addMember(orgId, m, 'member');
        t.mailPost.mockClear();

        await t
          .del(`/v1/orgs/${orgId}/members/${mId}`)
          .set('Cookie', a.cookie)
          .expect(204);

        expect(t.mailPost).not.toHaveBeenCalled();
      });

      it('mails the admins and the demoted person when an admin is demoted', async () => {
        const aEmail = email();
        const bEmail = email();
        const a = await t.user({ email: aEmail, totp: true });
        const b = await t.user({ email: bEmail, totp: true });
        const orgId = await t.createOrg(a);
        const bId = await t.addMember(orgId, b, 'admin');

        await t
          .patch(`/v1/orgs/${orgId}/members/${bId}/role`)
          .set('Cookie', a.cookie)
          .send({ role: 'member' })
          .expect(204);

        expect(
          mails(/admin role was removed/i)
            .map((m) => m.to)
            .toSorted(),
        ).toEqual([aEmail, bEmail].toSorted());
      });

      it("mails the admins and the member when a member's 2FA is reset", async () => {
        const aEmail = email();
        const targetEmail = email();
        const a = await t.user({ email: aEmail, totp: true });
        const target = await t.user({ email: targetEmail, totp: true });
        const orgId = await t.createOrg(a);
        const memberId = await t.addMember(orgId, target, 'member');

        await t
          .post(`/v1/orgs/${orgId}/members/${memberId}/factors/reset`)
          .set('Cookie', a.cookie)
          .expect(204);

        expect(
          mails(/two-factor/i)
            .map((m) => m.to)
            .toSorted(),
        ).toEqual([aEmail, targetEmail].toSorted());
      });

      it('completes the action when the mail provider fails', async () => {
        const a = await t.user({ email: email(), totp: true });
        const b = await t.user({ email: email(), totp: true });
        const orgId = await t.createOrg(a);
        const bId = await t.addMember(orgId, b, 'admin');
        t.mailPost.mockRejectedValue(new Error('resend down'));
        try {
          await t
            .del(`/v1/orgs/${orgId}/members/${bId}`)
            .set('Cookie', a.cookie)
            .expect(204);
        } finally {
          t.mailPost.mockReset();
          t.mailPost.mockResolvedValue({ status: 200, data: {} });
        }
        expect(await memberIdOf(orgId, a)).toEqual(expect.any(String));
        expect(await t.adminCount(orgId)).toBe(1);
      });
    });
  });
  describe('review fixes round 2 (2026-11-10)', () => {
    const roleOf = async (memberId: string): Promise<string> => {
      const [{ key }] = await t.sql.query(
        `SELECT r.key FROM role_bindings rb JOIN roles r ON r.id = rb.role_id
         WHERE rb.member_id = $1 AND rb.scope = 'org'`,
        [memberId],
      );
      return key;
    };

    it.each(['wallet', 'email'] as const)(
      'grants member at acceptance even when a legacy %s invitation is bound to admin (item 2)',
      async (kind) => {
        const admin = await t.user({ wallet: true });
        const orgId = await t.createOrg(admin);
        const to = email();
        const invitee = await t.user(
          kind === 'wallet' ? { wallet: true } : { email: to },
        );
        let memberId: string;
        let token: string | undefined;
        if (kind === 'wallet') {
          const res = await t
            .post(`/v1/orgs/${orgId}/members/invite`)
            .set('Cookie', admin.cookie)
            .send({ wallet: invitee.wallet })
            .expect(201);
          memberId = res.body.id;
        } else {
          ({ memberId, token } = await inviteEmail(orgId, admin, to));
        }
        // an invitation stored before invitations were member-only
        await t.sql.query(
          `UPDATE role_bindings SET role_id = (SELECT id FROM roles WHERE org_id IS NULL AND key = 'admin')
           WHERE member_id = $1`,
          [memberId],
        );

        if (token) await accept(invitee, token).expect(200);
        else {
          await t
            .post(`/v1/orgs/${orgId}/members/accept`)
            .set('Cookie', invitee.cookie)
            .expect(200);
        }

        expect(await roleOf(memberId)).toBe('member');
        expect(await t.adminCount(orgId)).toBe(1);
      },
    );

    it('answers 409 not_active to a role change of an invited or declined member (item 2)', async () => {
      const admin = await t.user({ wallet: true });
      const orgId = await t.createOrg(admin);
      const invited = await t.user({ wallet: true });
      const decliner = await t.user({ wallet: true });
      const ids: Array<string> = [];
      for (const u of [invited, decliner]) {
        const res = await t
          .post(`/v1/orgs/${orgId}/members/invite`)
          .set('Cookie', admin.cookie)
          .send({ wallet: u.wallet })
          .expect(201);
        ids.push(res.body.id as string);
      }
      await t
        .post(`/v1/orgs/${orgId}/members/decline`)
        .set('Cookie', decliner.cookie)
        .expect(200);

      for (const id of ids) {
        const res = await t
          .patch(`/v1/orgs/${orgId}/members/${id}/role`)
          .set('Cookie', admin.cookie)
          .send({ role: 'admin' })
          .expect(409);
        expect(res.body).toEqual({
          statusCode: 409,
          message: expect.any(String),
          code: 'not_active',
        });
        expect(await roleOf(id)).toBe('member');
      }
      expect(await t.adminCount(orgId)).toBe(1);
    });

    it('limits role changes to 20 per hour per acting user (item 5)', async () => {
      const admin = await t.user({ wallet: true });
      const orgId = await t.createOrg(admin);
      const m = await t.user({ wallet: true });
      const mId = await t.addMember(orgId, m, 'member');
      const change = (role: string): ReturnType<OrgTestApp['patch']> =>
        t
          .patch(`/v1/orgs/${orgId}/members/${mId}/role`)
          .set('Cookie', admin.cookie)
          .send({ role });
      for (let i = 0; i < 20; i++) {
        await change(i % 2 ? 'member' : 'admin').expect(204);
      }
      await change('admin').expect(429);
      expect(await roleOf(mId)).toBe('member');
    });

    it("mails the active admins of every org of the target once, and the target, when an admin resets the target's 2FA, in parallel (items 4, 5)", async () => {
      const [aEmail, cEmail, targetEmail, otherEmail] = [
        email(),
        email(),
        email(),
        email(),
      ];
      const a = await t.user({ email: aEmail, totp: true });
      const c = await t.user({ email: cEmail, totp: true });
      const target = await t.user({ email: targetEmail, totp: true });
      const outsider = await t.user({ email: otherEmail, totp: true });
      const orgA = await t.createOrg(a, 'A');
      const orgB = await t.createOrg(a, 'B');
      await t.createOrg(outsider, 'Unrelated');
      await t.addMember(orgB, c, 'admin');
      const memberId = await t.addMember(orgA, target, 'member');
      await t.addMember(orgB, target, 'member');
      let inFlight = 0;
      let maxInFlight = 0;
      const sentTo: Array<string> = [];
      t.mailPost.mockImplementation(
        async (args: { data: { to: Array<string> } }) => {
          sentTo.push(args.data.to[0]);
          maxInFlight = Math.max(maxInFlight, ++inFlight);
          await new Promise((r) => setTimeout(r, 50));
          inFlight--;
          return { status: 200, data: {} };
        },
      );
      try {
        await t
          .post(`/v1/orgs/${orgA}/members/${memberId}/factors/reset`)
          .set('Cookie', a.cookie)
          .expect(204);
      } finally {
        t.mailPost.mockReset();
        t.mailPost.mockResolvedValue({ status: 200, data: {} });
      }

      // A admins both orgs: one mail; the outsider's org is unrelated
      expect(sentTo.toSorted()).toEqual(
        [aEmail, cEmail, targetEmail].toSorted(),
      );
      // sent concurrently (Promise.allSettled), not one after another
      expect(maxInFlight).toBe(3);
    });
  });
});
