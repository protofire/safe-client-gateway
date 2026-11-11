import {
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { IConfigurationService } from '@/config/configuration.service.interface';
import { IS_PUBLIC, type OrgRequest } from '@/modules/org/auth/decorators';
import { SessionsRepository } from '@/modules/org/auth/sessions.repository';
import { Clock, type IClock } from '@/modules/org/common/clock';

// __Host- (Secure, Path=/, no Domain): sibling subdomains such as Safe Apps cannot toss or shadow it
export const SESSION_COOKIE = '__Host-org_session';
export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: '/',
} as const;

/** Sets (or replaces, after rotation) the session cookie. */
export function setSessionCookie(
  res: Response,
  token: string,
  maxAgeSeconds: number,
): void {
  res.cookie(SESSION_COOKIE, token, {
    ...SESSION_COOKIE_OPTIONS,
    maxAge: maxAgeSeconds * 1000,
  });
}
const TOUCH_INTERVAL_MS = 60_000;

/** Global for /v1/orgs/**; `@Public()` opts a route out. */
@Injectable()
export class SessionGuard implements CanActivate {
  private readonly idleTtlSeconds: number;

  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionsRepository,
    @Inject(Clock) private readonly clock: IClock,
    @Inject(IConfigurationService) config: IConfigurationService,
  ) {
    this.idleTtlSeconds = config.getOrThrow<number>(
      'org.session.idleTtlSeconds',
    );
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<OrgRequest>();
    const isOrgPath =
      req.path === '/v1/orgs' || req.path.startsWith('/v1/orgs/');
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!isOrgPath || isPublic) return true;

    const token: unknown = req.cookies?.[SESSION_COOKIE];
    if (typeof token !== 'string' || token === '') {
      throw new UnauthorizedException();
    }
    const now = this.clock.now();
    const session = await this.sessions.findActive(token, now);
    if (!session) throw new UnauthorizedException();

    // Sliding idle expiry, written at most once per minute per session
    if (now.getTime() - session.updatedAt.getTime() >= TOUCH_INTERVAL_MS) {
      await this.sessions.touch(session.id, now, this.idleTtlSeconds);
    }
    req.orgSession = {
      userId: session.userId,
      sessionId: session.id,
      amr: session.amr,
      lastStrongAuthAt: session.lastStrongAuthAt,
    };
    return true;
  }
}
