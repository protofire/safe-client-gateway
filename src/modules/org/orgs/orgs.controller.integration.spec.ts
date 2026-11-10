import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { APP_URL } from '@/modules/org/auth/__tests__/auth-test-app';
import { SecurityEvents } from '@/modules/org/auth/security-events';
import { PurgeProcessor } from '@/modules/org/jobs/purge.processor';
import {
  createOrgTestApp,
  type OrgTestApp,
} from '@/modules/org/orgs/__tests__/org-test-app';

jest.setTimeout(60_000);

const DAY_MS = 24 * 3600 * 1000;

describe('organizations (org)', () => {
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

  it('creates an org and makes the creator its only admin', async () => {
    const owner = await t.user({ wallet: true });

    const res = await t
      .post('/v1/orgs')
      .set('Cookie', owner.cookie)
      .send({ name: '  Acme  ' })
      .expect(201);

    expect(res.body).toEqual({
      id: expect.any(String),
      name: 'Acme',
      status: 'active',
      createdAt: expect.any(String),
      purgeAfter: null,
    });
    const members = await t.sql.query(
      `SELECT m.user_id AS "userId", m.status, r.key FROM members m
       JOIN role_bindings rb ON rb.member_id = m.id JOIN roles r ON r.id = rb.role_id
       WHERE m.org_id = $1`,
      [res.body.id],
    );
    expect(members).toEqual([
      { userId: owner.userId, status: 'active', key: 'admin' },
    ]);
    const me = await t
      .http()
      .get(`/v1/orgs/${res.body.id}/me`)
      .set('Cookie', owner.cookie)
      .expect(200);
    expect(me.body.permissions).toContain('org.delete');
    const [event] = await t.sql.query(
      `SELECT type, actor_user_id AS "actorUserId" FROM activity_events WHERE org_id = $1`,
      [res.body.id],
    );
    expect(event).toEqual({ type: 'org.created', actorUserId: owner.userId });
  });

  it('rejects an empty or too long name', async () => {
    const owner = await t.user();
    for (const name of ['', '   ', 'x'.repeat(65)]) {
      await t
        .post('/v1/orgs')
        .set('Cookie', owner.cookie)
        .send({ name })
        .expect(400);
    }
  });

  it('limits a user to 10 orgs', async () => {
    const owner = await t.user();
    for (let i = 0; i < 10; i++) await t.createOrg(owner, `org ${i}`);

    const res = await t
      .post('/v1/orgs')
      .set('Cookie', owner.cookie)
      .send({ name: 'one too many' })
      .expect(409);

    expect(res.body.code).toBe('org_limit');
  });

  it('keeps the 10-org limit under concurrent creates', async () => {
    const owner = await t.user();
    for (let i = 0; i < 8; i++) await t.createOrg(owner, `org ${i}`);

    const statuses = (
      await Promise.all(
        [1, 2, 3].map((i) =>
          t
            .post('/v1/orgs')
            .set('Cookie', owner.cookie)
            .send({ name: `p${i}` }),
        ),
      )
    ).map((r) => r.status);

    expect(statuses.toSorted()).toEqual([201, 201, 409]);
  });

  it('renames with org.update and logs from/to; members get 403', async () => {
    const owner = await t.user({ wallet: true });
    const member = await t.user({ wallet: true });
    const orgId = await t.createOrg(owner, 'Old');
    await t.addMember(orgId, member, 'member');

    await t
      .patch(`/v1/orgs/${orgId}`)
      .set('Cookie', member.cookie)
      .send({ name: 'Nope' })
      .expect(403);
    const res = await t
      .patch(`/v1/orgs/${orgId}`)
      .set('Cookie', owner.cookie)
      .send({ name: 'New' })
      .expect(200);

    expect(res.body.name).toBe('New');
    const [event] = await t.sql.query(
      `SELECT payload FROM activity_events WHERE org_id = $1 AND type = 'org.renamed'`,
      [orgId],
    );
    expect(event.payload).toEqual({ from: 'Old', to: 'New' });
  });

  it('returns 403 totp_required to an email-only admin without TOTP (A17)', async () => {
    const admin = await t.user({ email: 'solo@example.com', strong: false });
    const orgId = await t.createOrg(admin);

    type Req = ReturnType<OrgTestApp['post']>;
    const requests: Array<() => Req> = [
      (): Req => t.patch(`/v1/orgs/${orgId}`).send({ name: 'X' }),
      (): Req =>
        t.post(`/v1/orgs/${orgId}/members/invite`).send({
          email: 'x@example.com',
          role: 'member',
        }),
      (): Req => t.del(`/v1/orgs/${orgId}`),
    ];
    for (const req of requests) {
      const res = await req().set('Cookie', admin.cookie).expect(403);
      expect(res.body).toEqual({
        statusCode: 403,
        message: expect.any(String),
        code: 'totp_required',
      });
    }
    // with a confirmed TOTP the same admin is asked to step up instead
    const withTotp = await t.user({
      email: 'totp@example.com',
      totp: true,
      strong: false,
    });
    const other = await t.createOrg(withTotp);
    const res = await t
      .patch(`/v1/orgs/${other}`)
      .set('Cookie', withTotp.cookie)
      .send({ name: 'X' })
      .expect(403);
    expect(res.body.code).toBe('step_up_required');
  });

  describe('deletion, restore and purge (A10)', () => {
    async function deletedOrg(): Promise<{
      orgId: string;
      admin: Awaited<ReturnType<OrgTestApp['user']>>;
      member: Awaited<ReturnType<OrgTestApp['user']>>;
    }> {
      const admin = await t.user({ wallet: true });
      const member = await t.user({ wallet: true });
      const orgId = await t.createOrg(admin);
      await t.addMember(orgId, member, 'member');
      await t.del(`/v1/orgs/${orgId}`).set('Cookie', admin.cookie).expect(200);
      return { orgId, admin, member };
    }

    it('mails every active admin with an email when the org is deleted (item 2)', async () => {
      const aEmail = 'a-del@example.com';
      const bEmail = 'b-del@example.com';
      const a = await t.user({ email: aEmail, totp: true });
      const b = await t.user({ email: bEmail });
      const m = await t.user({ email: 'm-del@example.com' });
      const orgId = await t.createOrg(a, 'Visit https://evil.example.com now');
      await t.addMember(orgId, b, 'admin');
      await t.addMember(orgId, m, 'member');
      t.mailPost.mockClear();

      await t.del(`/v1/orgs/${orgId}`).set('Cookie', a.cookie).expect(200);

      const sent = t.mailPost.mock.calls.map(([args]) => args.data);
      expect(sent.map((d) => d.to[0]).toSorted()).toEqual(
        [aEmail, bEmail].toSorted(),
      );
      for (const d of sent) {
        expect(d.subject).toMatch(/deleted/i);
        expect(`${d.subject} ${d.text} ${d.html}`).not.toMatch(
          /https?:|www\.|evil\.example\.com/i,
        );
      }
    });

    it('hides a deleted org from members and lists it for admins with includeDeleted', async () => {
      const { orgId, admin, member } = await deletedOrg();

      const list = (
        cookie: string,
        q = '',
      ): Promise<{ body: Array<{ id: string }> }> =>
        t.http().get(`/v1/orgs${q}`).set('Cookie', cookie).expect(200);
      expect((await list(member.cookie)).body).toEqual([]);
      expect((await list(member.cookie, '?includeDeleted=true')).body).toEqual(
        [],
      );
      expect((await list(admin.cookie)).body).toEqual([]);
      expect((await list(admin.cookie, '?includeDeleted=true')).body).toEqual([
        {
          id: orgId,
          name: 'Acme',
          status: 'deleted',
          myStatus: 'active',
          purgeAfter: expect.any(String),
        },
      ]);
      await t
        .http()
        .get(`/v1/orgs/${orgId}`)
        .set('Cookie', member.cookie)
        .expect(404);
      await t
        .http()
        .get(`/v1/orgs/${orgId}/members`)
        .set('Cookie', admin.cookie)
        .expect(404);
      const view = await t
        .http()
        .get(`/v1/orgs/${orgId}`)
        .set('Cookie', admin.cookie)
        .expect(200);
      const purgeAfter = new Date(String(view.body.purgeAfter)).getTime();
      expect(Math.abs(purgeAfter - (Date.now() + 30 * DAY_MS))).toBeLessThan(
        60_000,
      );
    });

    it('restores before purge; a member cannot restore', async () => {
      const { orgId, admin, member } = await deletedOrg();

      await t
        .post(`/v1/orgs/${orgId}/restore`)
        .set('Cookie', member.cookie)
        .expect(404);
      const res = await t
        .post(`/v1/orgs/${orgId}/restore`)
        .set('Cookie', admin.cookie)
        .expect(200);

      expect(res.body).toMatchObject({ status: 'active', purgeAfter: null });
      await t
        .http()
        .get(`/v1/orgs/${orgId}/members`)
        .set('Cookie', member.cookie)
        .expect(200);
    });

    it('purges after 30 days with everything scoped to the org, and no longer restores', async () => {
      const { orgId, admin } = await deletedOrg();
      const keep = await t.createOrg(admin, 'Keep');
      await t.sql.transaction(async (em) => {
        await em.query(`SELECT set_config('app.org_id', $1, true)`, [orgId]);
        await em.query(
          `INSERT INTO contacts (org_id, name, address) VALUES ($1, 'c', '0x0000000000000000000000000000000000000001')`,
          [orgId],
        );
      });
      const purge = t.app.get(PurgeProcessor);

      // other tests in this file leave deleted orgs behind: assert on this one
      t.setOffset(29 * DAY_MS);
      expect(await purge.purgeDue()).not.toContain(orgId);
      t.setOffset(31 * DAY_MS);
      expect(await purge.purgeDue()).toContain(orgId);

      for (const table of ['organizations', 'members', 'activity_events']) {
        const column = table === 'organizations' ? 'id' : 'org_id';
        const rows = await t.sql.query(
          `SELECT 1 FROM ${table} WHERE ${column} = $1`,
          [orgId],
        );
        expect(rows).toEqual([]);
      }
      const [{ count }] = await t.sql.transaction(async (em) => {
        await em.query(`SELECT set_config('app.org_id', $1, true)`, [orgId]);
        return em.query(`SELECT count(*)::int AS count FROM contacts`);
      });
      expect(count).toBe(0);
      expect(
        await t.sql.query(`SELECT 1 FROM organizations WHERE id = $1`, [keep]),
      ).toHaveLength(1);
    });

    it('skips an org a restore holds locked, so purge and restore never both win', async () => {
      const { orgId } = await deletedOrg();
      t.setOffset(31 * DAY_MS);
      const purge = t.app.get(PurgeProcessor);
      const runner = t.sql.createQueryRunner();
      await runner.connect();
      try {
        await runner.startTransaction();
        await runner.query(`SET LOCAL lock_timeout = '5s'`);
        // what restore holds while it checks purge_after
        await runner.query(
          `SELECT 1 FROM organizations WHERE id = $1 FOR UPDATE`,
          [orgId],
        );

        expect(await purge.purgeDue()).not.toContain(orgId);

        await runner.commitTransaction();
      } finally {
        if (runner.isTransactionActive) await runner.rollbackTransaction();
        await runner.release();
      }
      expect(await purge.purgeDue()).toContain(orgId);
    });

    it('drops processed_events older than 30 days in the same job (final gate F4)', async () => {
      const key = `test-${Date.now()}-${Math.random()}`;
      await t.sql.query(
        `INSERT INTO processed_events (event_key) VALUES ($1)`,
        [key],
      );
      const purge = t.app.get(PurgeProcessor);
      const exists = async (): Promise<boolean> =>
        (
          await t.sql.query(
            `SELECT 1 FROM processed_events WHERE event_key = $1`,
            [key],
          )
        ).length === 1;

      t.setOffset(29 * DAY_MS);
      await purge.run();
      expect(await exists()).toBe(true);
      t.setOffset(31 * DAY_MS);
      await purge.run();
      expect(await exists()).toBe(false);
    });

    it('refuses restore once purge_after passed, also racing the purge', async () => {
      const { orgId, admin } = await deletedOrg();
      // moved in the DB, not with the Clock: the admin's session must stay fresh
      await t.sql.query(
        `UPDATE organizations SET purge_after = now() - interval '1 second' WHERE id = $1`,
        [orgId],
      );
      await t
        .post(`/v1/orgs/${orgId}/restore`)
        .set('Cookie', admin.cookie)
        .expect(404);

      const [restore, purged] = await Promise.all([
        t.post(`/v1/orgs/${orgId}/restore`).set('Cookie', admin.cookie),
        t.app.get(PurgeProcessor).purgeDue(),
      ]);

      expect(restore.status).toBe(404);
      expect(purged).toContain(orgId);
      expect(
        await t.sql.query(`SELECT 1 FROM organizations WHERE id = $1`, [orgId]),
      ).toEqual([]);
    });
  });

  it('keeps sign-in per user and fans other security events out to each org of the user (F4)', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const signIn = async (): Promise<string> => {
      const { body } = await t
        .http()
        .get('/v1/orgs/auth/nonce')
        .set('X-Forwarded-For', '10.8.0.1')
        .expect(200);
      const message = createSiweMessage({
        address: account.address,
        chainId: 1,
        domain: 'app.example.com',
        nonce: body.nonce,
        uri: APP_URL,
        version: '1',
      });
      const res = await t
        .post('/v1/orgs/auth/siwe')
        .send({ message, signature: await account.signMessage({ message }) })
        .expect(200);
      return res.body.user.id;
    };
    const userId = await signIn();
    const owner = await t.user({ wallet: true });
    const [a, b, other] = [
      await t.createOrg(owner, 'A'),
      await t.createOrg(owner, 'B'),
      await t.createOrg(owner, 'Other'),
    ];
    const user = { userId, cookie: '', wallet: null, email: null };
    await t.addMember(a, user, 'member');
    await t.addMember(b, user, 'member');

    await signIn();
    await t.app
      .get(SecurityEvents)
      .record(userId, 'security.step_up', { method: 'totp' }, '10.8.0.2');

    const events: Array<{ orgId: string; type: string }> = await t.sql.query(
      `SELECT org_id AS "orgId", type FROM activity_events
       WHERE actor_user_id = $1 ORDER BY org_id`,
      [userId],
    );
    expect(events).toEqual(
      [a, b].toSorted().map((orgId) => ({ orgId, type: 'security.step_up' })),
    );
    expect(events.map((e) => e.orgId)).not.toContain(other);
    const [{ count }] = await t.sql.query(
      `SELECT count(*)::int AS count FROM user_security_events WHERE user_id = $1 AND type = 'security.signed_in'`,
      [userId],
    );
    expect(count).toBe(2);
  });

  it('re-checks the permission under the org lock: the waiting delete of a demoted admin gets 403 (F3)', async () => {
    const a = await t.user({ wallet: true });
    const b = await t.user({ wallet: true });
    const orgId = await t.createOrg(a);
    const bId = await t.addMember(orgId, b, 'admin');
    const lock = await t.holdOrgLock(orgId);
    let pending: Promise<{ status: number }> | undefined;
    try {
      pending = t
        .del(`/v1/orgs/${orgId}`)
        .set('Cookie', b.cookie)
        .then((r) => r);
      await lock.blocked();
    } finally {
      await lock.release(async (q) => {
        await q.query(
          `UPDATE role_bindings SET role_id = (SELECT id FROM roles WHERE org_id IS NULL AND key = 'member')
           WHERE member_id = $1`,
          [bId],
        );
      });
    }

    expect((await pending).status).toBe(403);
    const [org] = await t.sql.query(
      `SELECT status FROM organizations WHERE id = $1`,
      [orgId],
    );
    expect(org.status).toBe('active');
  });

  it('answers totp_required after a wallet-less user removes their last TOTP, even within the window (F6)', async () => {
    const user = await t.user({ email: 'f6@example.com', totp: true });
    const orgId = await t.createOrg(user);

    await t.del('/v1/orgs/auth/totp').set('Cookie', user.cookie).expect(204);

    const res = await t
      .patch(`/v1/orgs/${orgId}`)
      .set('Cookie', user.cookie)
      .send({ name: 'X' })
      .expect(403);
    expect(res.body.code).toBe('totp_required');
    const [session] = await t.sql.query(
      `SELECT last_strong_auth_at AS "at" FROM sessions WHERE user_id = $1`,
      [user.userId],
    );
    expect(session.at).toBeNull();
  });

  it('applies the 10-org limit on restore (F7)', async () => {
    const owner = await t.user({ wallet: true });
    const ids: Array<string> = [];
    for (let i = 0; i < 10; i++) ids.push(await t.createOrg(owner, `org ${i}`));
    await t.del(`/v1/orgs/${ids[0]}`).set('Cookie', owner.cookie).expect(200);
    await t.createOrg(owner, 'replacement');

    const res = await t
      .post(`/v1/orgs/${ids[0]}/restore`)
      .set('Cookie', owner.cookie)
      .expect(409);

    expect(res.body.code).toBe('org_limit');
  });
});
