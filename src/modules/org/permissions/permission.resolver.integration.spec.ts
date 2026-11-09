import { Controller, Get, type INestApplication, Req } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { Request } from 'express';
import type { Server } from 'net';
import request from 'supertest';
import type { DataSource, EntityManager } from 'typeorm';
import {
  createOrgTestDb,
  type OrgTestDb,
} from '@/modules/org/db/__tests__/org-test-db';
import { ORG_DATA_SOURCE } from '@/modules/org/db/org-data-source';
import { PermissionResolver } from '@/modules/org/permissions/permission.resolver';
import { PERMISSIONS } from '@/modules/org/permissions/permissions';
import {
  AllowDeletedOrg,
  RequirePermission,
} from '@/modules/org/permissions/require-permission.decorator';
import { runOrgMigrations } from '@/org-migrate';

const MEMBER_PERMISSIONS = [
  'org.view',
  'members.view',
  'safes.view',
  'addressbook.view',
  'addressbook.request',
  'activity.view',
  'exports.read',
];

@Controller('v1/orgs/:orgId')
class GuardedController {
  @Get('view')
  @RequirePermission('org.view')
  view(@Req() req: Request): unknown {
    return req.orgMember;
  }

  @Get('update')
  @RequirePermission('org.update')
  update(): string {
    return 'updated';
  }

  @Get('restore')
  @AllowDeletedOrg()
  @RequirePermission('org.view')
  restore(): string {
    return 'restored';
  }
}

describe('permissions (through the app login)', () => {
  let db: OrgTestDb;
  let owner: DataSource;
  let dataSource: DataSource;
  let resolver: PermissionResolver;
  let app: INestApplication<Server>;
  const roleIds: Record<string, string> = {};

  beforeAll(async () => {
    db = await createOrgTestDb();
    owner = db.owner();
    await owner.initialize();
    await runOrgMigrations(owner, db.appUser);
    dataSource = db.app();
    await dataSource.initialize();
    for (const { id, key } of await dataSource.query(
      `SELECT id, key FROM roles WHERE org_id IS NULL`,
    )) {
      roleIds[key] = id;
    }

    const moduleRef = await Test.createTestingModule({
      controllers: [GuardedController],
      providers: [
        PermissionResolver,
        { provide: getDataSourceToken(ORG_DATA_SOURCE), useValue: dataSource },
      ],
    }).compile();
    resolver = moduleRef.get(PermissionResolver);
    app = moduleRef.createNestApplication();
    // stands in for the session guard (Task 4)
    app.use((req: Request, _res: unknown, next: () => void) => {
      const userId = req.headers['x-test-user'];
      if (typeof userId === 'string') {
        Object.assign(req, {
          orgSession: {
            userId,
            sessionId: crypto.randomUUID(),
            amr: [],
            lastStrongAuthAt: null,
          },
        });
      }
      next();
    });
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await dataSource?.destroy();
    await owner?.destroy();
    await db?.drop();
  });

  async function addMember(
    em: EntityManager,
    orgId: string,
    status: 'active' | 'invited' | 'declined',
    roleKey: string,
  ): Promise<string> {
    const [{ id: userId }] = await em.query(
      `INSERT INTO users DEFAULT VALUES RETURNING id`,
    );
    const [{ id: memberId }] = await em.query(
      `INSERT INTO members (org_id, user_id, status) VALUES ($1, $2, $3) RETURNING id`,
      [orgId, userId, status],
    );
    await em.query(
      `INSERT INTO role_bindings (member_id, role_id) VALUES ($1, $2)`,
      [memberId, roleIds[roleKey]],
    );
    return userId;
  }

  /** Org with one user per member kind; returns their user ids. */
  function seedOrg(): Promise<{
    orgId: string;
    admin: string;
    member: string;
    invited: string;
    declined: string;
  }> {
    return dataSource.transaction(async (em) => {
      const [{ id: orgId }]: Array<{ id: string }> = await em.query(
        `INSERT INTO organizations (name) VALUES ('org') RETURNING id`,
      );
      return {
        orgId,
        admin: await addMember(em, orgId, 'active', 'admin'),
        member: await addMember(em, orgId, 'active', 'member'),
        invited: await addMember(em, orgId, 'invited', 'member'),
        declined: await addMember(em, orgId, 'declined', 'member'),
      };
    });
  }

  describe('PermissionResolver.effective', () => {
    it('returns null for an invited member', async () => {
      const org = await seedOrg();

      await expect(resolver.effective(org.orgId, org.invited)).resolves.toBe(
        null,
      );
    });

    it('returns null for a declined member', async () => {
      const org = await seedOrg();

      await expect(resolver.effective(org.orgId, org.declined)).resolves.toBe(
        null,
      );
    });

    it('returns null for a user of another org', async () => {
      const a = await seedOrg();
      const b = await seedOrg();

      await expect(resolver.effective(b.orgId, a.admin)).resolves.toBe(null);
    });

    it('gives member exactly the member permission set', async () => {
      const org = await seedOrg();

      const effective = await resolver.effective(org.orgId, org.member);

      expect(effective?.permissions.toSorted()).toEqual(
        MEMBER_PERMISSIONS.toSorted(),
      );
    });

    it('gives admin the full permission set', async () => {
      const org = await seedOrg();

      const effective = await resolver.effective(org.orgId, org.admin);

      expect(effective?.permissions.toSorted()).toEqual(
        [...PERMISSIONS].toSorted(),
      );
      expect(effective?.memberId).toEqual(expect.any(String));
    });
  });

  describe('OrgMemberGuard', () => {
    function get(
      path: string,
      userId?: string,
    ): ReturnType<ReturnType<typeof request>['get']> {
      const req = request(app.getHttpServer()).get(path);
      return userId === undefined ? req : req.set('x-test-user', userId);
    }

    it('lets an active member through and attaches req.orgMember', async () => {
      const org = await seedOrg();

      const res = await get(`/v1/orgs/${org.orgId}/view`, org.member).expect(
        200,
      );

      expect(res.body).toEqual({
        orgId: org.orgId,
        memberId: expect.any(String),
        orgStatus: 'active',
        permissions: expect.arrayContaining(MEMBER_PERMISSIONS),
      });
    });

    it('answers 404 to a user of org A for org B', async () => {
      const a = await seedOrg();
      const b = await seedOrg();

      await get(`/v1/orgs/${b.orgId}/view`, a.admin).expect(404);
      await get(`/v1/orgs/${b.orgId}/update`, a.admin).expect(404);
    });

    it('answers 404 to invited and declined members', async () => {
      const org = await seedOrg();

      await get(`/v1/orgs/${org.orgId}/view`, org.invited).expect(404);
      await get(`/v1/orgs/${org.orgId}/view`, org.declined).expect(404);
    });

    it('answers 404 for an orgId that is not a UUID', async () => {
      const org = await seedOrg();

      await get(`/v1/orgs/not-a-uuid/view`, org.admin).expect(404);
    });

    it('answers 404 for a deleted org except on @AllowDeletedOrg() routes', async () => {
      const org = await seedOrg();
      await dataSource.query(
        `UPDATE organizations SET status = 'deleted', deleted_at = now(),
           purge_after = now() + interval '30 days' WHERE id = $1`,
        [org.orgId],
      );

      await get(`/v1/orgs/${org.orgId}/view`, org.admin).expect(404);
      await get(`/v1/orgs/${org.orgId}/restore`, org.admin).expect(
        200,
        'restored',
      );
    });

    it('answers 403 when the permission is missing', async () => {
      const org = await seedOrg();

      await get(`/v1/orgs/${org.orgId}/update`, org.member).expect(403);
      await get(`/v1/orgs/${org.orgId}/update`, org.admin).expect(
        200,
        'updated',
      );
    });

    it('answers 401 without req.orgSession', async () => {
      const org = await seedOrg();

      await get(`/v1/orgs/${org.orgId}/view`).expect(401);
    });
  });
});
