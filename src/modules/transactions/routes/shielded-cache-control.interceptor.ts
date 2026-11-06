import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Observable } from 'rxjs';
import { ShieldedAccessService } from '@/modules/transactions/routes/shielded-access.service';

/**
 * Responses on shielded chains depend on the caller's session, so they must
 * not be stored by shared caches.
 */
@Injectable()
export class ShieldedCacheControlInterceptor implements NestInterceptor {
  constructor(private readonly shieldedAccessService: ShieldedAccessService) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const request: Request = context.switchToHttp().getRequest();
    const chainId = request.params.chainId;
    if (await this.shieldedAccessService.isShielded(chainId)) {
      const response: Response = context.switchToHttp().getResponse();
      response.setHeader('Cache-Control', 'private, no-store');
      response.vary('Cookie');
    }
    return next.handle();
  }
}
