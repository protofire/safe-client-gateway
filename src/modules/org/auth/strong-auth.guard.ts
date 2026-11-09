import {
  ForbiddenException,
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { IConfigurationService } from '@/config/configuration.service.interface';
import { AuthService } from '@/modules/org/auth/auth.service';
import type { OrgRequest } from '@/modules/org/auth/decorators';
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

    const last = session.lastStrongAuthAt;
    if (last && this.clock.now().getTime() - last.getTime() <= this.windowMs) {
      return true;
    }

    const methods = await this.auth.stepUpMethods(session.userId);
    if (methods.length === 0) {
      throw new ForbiddenException({
        statusCode: 403,
        message: 'Enable two-factor authentication first',
        code: 'totp_required',
      });
    }
    throw new ForbiddenException({
      statusCode: 403,
      message: 'Fresh strong authentication required',
      code: 'step_up_required',
      methods,
    });
  }
}
