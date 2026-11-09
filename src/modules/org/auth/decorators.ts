import {
  createParamDecorator,
  SetMetadata,
  UseGuards,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';
import { StrongAuthGuard } from '@/modules/org/auth/strong-auth.guard';

/** Attached to the request by SessionGuard. */
export type OrgSession = {
  userId: string;
  sessionId: string;
  amr: Array<string>;
  lastStrongAuthAt: Date | null;
};

export type OrgRequest = Request & { orgSession?: OrgSession };

export const IS_PUBLIC = 'org:isPublic';

/** Opts a route out of the global SessionGuard. */
export const Public = (): MethodDecorator & ClassDecorator =>
  SetMetadata(IS_PUBLIC, true);

/** 403 `step_up_required` / `totp_required` unless strong auth is fresh. */
export const RequireStrongAuth = (): MethodDecorator & ClassDecorator =>
  UseGuards(StrongAuthGuard);

/** The session SessionGuard attached; only on non-public routes. */
export const OrgSession = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): OrgSession => {
    const session = ctx.switchToHttp().getRequest<OrgRequest>().orgSession;
    if (!session) throw new Error('@OrgSession() used on a public route');
    return session;
  },
);
