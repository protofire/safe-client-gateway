import {
  ForbiddenException,
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { IConfigurationService } from '@/config/configuration.service.interface';
import { AuthService } from '@/modules/org/auth/auth.service';
import type { OrgRequest, OrgSession } from '@/modules/org/auth/decorators';
import { Clock, type IClock } from '@/modules/org/common/clock';

/** Applied by `@RequireStrongAuth()`; runs after the global SessionGuard. */
@Injectable()
export class StrongAuthGuard implements CanActivate {
  private readonly windowMs: number;

  constructor(
    private readonly auth: AuthService,
    @Inject(Clock) private readonly clock: IClock,
    @Inject(IConfigurationService) config: IConfigurationService,
  ) {
    this.windowMs =
      config.getOrThrow<number>('org.session.strongAuthWindowSeconds') * 1000;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const session = context.switchToHttp().getRequest<OrgRequest>().orgSession;
    if (!session) throw new Error('StrongAuthGuard needs SessionGuard first');

    if (this.isFresh(session)) return true;
    throw await this.denial(session.userId);
  }

  isFresh(session: OrgSession): boolean {
    const last = session.lastStrongAuthAt;
    return (
      last !== null &&
      this.clock.now().getTime() - last.getTime() <= this.windowMs
    );
  }

  /** The 403 for a session without fresh strong auth. */
  async denial(userId: string): Promise<ForbiddenException> {
    const methods = await this.auth.stepUpMethods(userId);
    if (methods.length === 0) {
      return new ForbiddenException({
        statusCode: 403,
        message: 'Enable two-factor authentication first',
        code: 'totp_required',
      });
    }
    return new ForbiddenException({
      statusCode: 403,
      message: 'Fresh strong authentication required',
      code: 'step_up_required',
      methods,
    });
  }
}
