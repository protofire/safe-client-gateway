import { AuthGuard } from '@/modules/auth/routes/guards/auth.guard';
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Request } from 'express';

/**
 * Attaches the auth payload when the request has a valid access token.
 * A missing, expired or invalid token never blocks the request: it continues
 * as anonymous, without a payload.
 */
@Injectable()
export class AnonymousFallbackAuthGuard implements CanActivate {
  constructor(private readonly authGuard: AuthGuard) {}

  canActivate(context: ExecutionContext): boolean {
    try {
      if (this.authGuard.canActivate(context)) {
        return true;
      }
    } catch {
      // Fall through to anonymous
    }
    const request: Request = context.switchToHttp().getRequest();
    delete request[AuthGuard.AUTH_PAYLOAD_REQUEST_PROPERTY];
    return true;
  }
}
