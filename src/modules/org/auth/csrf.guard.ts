import {
  ForbiddenException,
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';
import { IConfigurationService } from '@/config/configuration.service.interface';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Global. State-changing requests need `X-Org-Request: 1` (a custom header
 * forces a CORS preflight, which only the public app origin passes) and, when
 * the browser sends an Origin, that exact origin.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  private readonly appOrigin: string;

  constructor(@Inject(IConfigurationService) config: IConfigurationService) {
    this.appOrigin = config.getOrThrow<string>('org.publicAppUrl');
  }

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(req.method)) return true;

    const origin = req.header('origin');
    if (req.header('x-org-request') !== '1') {
      throw new ForbiddenException('Missing X-Org-Request header');
    }
    if (origin !== undefined && origin !== this.appOrigin) {
      throw new ForbiddenException('Origin not allowed');
    }
    return true;
  }
}
