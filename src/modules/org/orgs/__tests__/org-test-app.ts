import { Global, Module } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type request from 'supertest';
import type { QueryRunner } from 'typeorm';
import { NetworkService } from '@/datasources/network/network.service.interface';
import { OrgAccountModule } from '@/modules/org/account/account.module';
import { ActivityModule } from '@/modules/org/activity/activity.module';
import {
  createAuthTestApp,
  seedUser,
  type AuthTestApp,
} from '@/modules/org/auth/__tests__/auth-test-app';
import { OrgTotpModule } from '@/modules/org/auth/totp/totp.module';
import { FieldEncryptionService } from '@/modules/org/crypto/field-encryption.service';
import { hmacEmail } from '@/modules/org/crypto/hashing';
import { ORG_PG_POOL } from '@/modules/org/db/org-database.module';
import { OrgJobsModule } from '@/modules/org/jobs/org-jobs.module';
import { PurgeProcessor } from '@/modules/org/jobs/purge.processor';
import { MembersModule } from '@/modules/org/members/members.module';
import { OrgsModule } from '@/modules/org/orgs/orgs.module';

export type OrgTestApp = AuthTestApp & {
  /** Resend stub: every POST {baseUrl}/emails lands here. */
  mailPost: jest.Mock;
  patch(path: string): request.Test;
  /** Raw invitation token from the last mail sent to `to`. */
  lastInviteToken(to: string): string;
  /** User with a session; strong now unless `strong: false`. */
  user(opts?: {
    wallet?: boolean;
    email?: string;
    totp?: boolean;
    strong?: boolean;
  }): Promise<TestUser>;
  /** POST /v1/orgs as `owner`; returns the org id. */
  createOrg(owner: TestUser, name?: string): Promise<string>;
  /** Adds an active member with a system role, straight in SQL. */
  addMember(orgId: string, user: TestUser, roleKey: string): Promise<string>;
  adminCount(orgId: string): Promise<number>;
  /**
   * Holds the org row FOR UPDATE in a separate transaction; `blocked()`
   * resolves once another backend waits on a lock, `release(fn)` runs `fn`
   * inside the holding transaction and commits.
   */
  holdOrgLock(orgId: string): Promise<{
    blocked(): Promise<void>;
    release(fn?: (q: QueryRunner) => Promise<void>): Promise<void>;
  }>;
};

export type TestUser = {
  userId: string;
  cookie: string;
  wallet: string | null;
  email: string | null;
};

const EMAIL_HASH_KEY = randomBytes(32).toString('base64');

/** Org feature modules on a fresh org DB, Resend stubbed, mail key set. */
export async function createOrgTestApp(redisDb: number): Promise<OrgTestApp> {
  // a small pool: a path that needs a second connection while holding the
  // org lock exhausts it under the parallel tests (gate B F1)
  const mailPost = jest.fn().mockResolvedValue({ status: 200, data: {} });

  @Global()
  @Module({
    providers: [{ provide: NetworkService, useValue: { post: mailPost } }],
    exports: [NetworkService],
  })
  class NetworkStubModule {}

  const t = await createAuthTestApp({
    redisDb,
    config: {
      'org.emailHashKey': EMAIL_HASH_KEY,
      'org.mail.apiKey': 'test-mail-key',
      'org.mail.from': 'noreply@example.com',
      'org.mail.baseUrl': 'https://mail.example.com',
    },
    dataSource: { extra: { ...ORG_PG_POOL, max: 5 } },
    imports: [
      NetworkStubModule,
      OrgTotpModule,
      OrgAccountModule,
      MembersModule,
      OrgsModule,
      ActivityModule,
      OrgJobsModule,
    ],
  });
  // tests call the jobs directly; a background run would race them
  t.app.get(PurgeProcessor).onModuleDestroy();
  const encryption = t.app.get(FieldEncryptionService);
  const key = Buffer.from(EMAIL_HASH_KEY, 'base64');

  const roleId = async (key: string): Promise<string> =>
    (
      await t.sql.query(
        `SELECT id FROM roles WHERE org_id IS NULL AND key = $1`,
        [key],
      )
    )[0].id;

  const app: OrgTestApp = {
    ...t,
    mailPost,
    patch: (path) =>
      t
        .http()
        .patch(path)
        .set('X-Org-Request', '1')
        .set('X-Forwarded-For', '10.9.0.1'),
    lastInviteToken: (to) => {
      const call = [...mailPost.mock.calls]
        .reverse()
        .find(([args]) => args.data.to[0] === to);
      if (!call) throw new Error(`no mail to ${to}`);
      const match = /#token=([A-Za-z0-9_-]+)/.exec(String(call[0].data.text));
      if (!match) throw new Error('no token in mail');
      return match[1];
    },
    user: async (opts = {}) => {
      const seeded = await seedUser(t.sql, {
        wallet: opts.wallet,
        strongAt: opts.strong === false ? null : new Date(Date.now() + 1000),
      });
      const [identity] = await t.sql.query(
        `SELECT wallet_address AS wallet FROM identities WHERE user_id = $1 AND kind = 'wallet'`,
        [seeded.userId],
      );
      if (opts.email) {
        await t.sql.query(
          `INSERT INTO identities (user_id, kind, oidc_issuer, oidc_subject, email_encrypted, email_hash)
           VALUES ($1, 'oidc', 'https://idp.example.com/', $2, $3, $4)`,
          [
            seeded.userId,
            randomBytes(8).toString('hex'),
            encryption.encrypt(opts.email),
            hmacEmail(opts.email, key),
          ],
        );
      }
      if (opts.totp) {
        await t.sql.query(
          `INSERT INTO factors (user_id, kind, secret_encrypted, confirmed_at)
           VALUES ($1, 'totp', $2, now())`,
          [seeded.userId, encryption.encrypt('JBSWY3DPEHPK3PXP')],
        );
      }
      return {
        ...seeded,
        wallet: identity?.wallet ?? null,
        email: opts.email ?? null,
      };
    },
    createOrg: async (owner, name = 'Acme') => {
      const res = await t
        .post('/v1/orgs')
        .set('Cookie', owner.cookie)
        .send({ name })
        .expect(201);
      return res.body.id;
    },
    addMember: async (orgId, user, roleKey) => {
      const id = await roleId(roleKey);
      return t.sql.transaction(async (em) => {
        const [{ id: memberId }] = await em.query(
          `INSERT INTO members (org_id, user_id, status) VALUES ($1, $2, 'active') RETURNING id`,
          [orgId, user.userId],
        );
        await em.query(
          `INSERT INTO role_bindings (member_id, role_id) VALUES ($1, $2)`,
          [memberId, id],
        );
        return memberId as string;
      });
    },
    holdOrgLock: async (orgId) => {
      const runner = t.sql.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      await runner.query(`SET LOCAL lock_timeout = '5s'`);
      await runner.query(
        `SELECT 1 FROM organizations WHERE id = $1 FOR UPDATE`,
        [orgId],
      );
      return {
        blocked: async (): Promise<void> => {
          for (let i = 0; i < 100; i++) {
            const [{ waiting }] = await t.sql.query(
              `SELECT count(*)::int AS waiting FROM pg_stat_activity
               WHERE datname = current_database() AND wait_event_type = 'Lock'`,
            );
            if (waiting > 0) return;
            await new Promise((r) => setTimeout(r, 50));
          }
          throw new Error('no backend blocked on the org lock within 5 s');
        },
        release: async (fn): Promise<void> => {
          try {
            if (fn) await fn(runner);
            await runner.commitTransaction();
          } finally {
            if (runner.isTransactionActive) await runner.rollbackTransaction();
            await runner.release();
          }
        },
      };
    },
    adminCount: async (orgId) => {
      const [{ count }] = await t.sql.query(
        `SELECT count(*)::int AS count FROM members m
         JOIN role_bindings rb ON rb.member_id = m.id
         JOIN roles r ON r.id = rb.role_id
         WHERE m.org_id = $1 AND m.status = 'active' AND r.key = 'admin'`,
        [orgId],
      );
      return count;
    },
  };
  return app;
}
