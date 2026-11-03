import { createHash, timingSafeEqual } from 'crypto';
import {
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';
import { IConfigurationService } from '@/config/configuration.service.interface';

const digest = (value: string): Buffer =>
  createHash('sha256').update(value).digest();

/** Basic auth against `mcp.usageAuth` (`user:pass`); every request is refused while it is unset. */
@Injectable()
export class McpUsageAuthGuard implements CanActivate {
  private readonly expected: Buffer | null;

  constructor(
    @Inject(IConfigurationService) configurationService: IConfigurationService,
  ) {
    const credentials = configurationService.get<string>('mcp.usageAuth');
    this.expected = credentials ? digest(credentials) : null;
  }

  canActivate(context: ExecutionContext): boolean {
    const header = context
      .switchToHttp()
      .getRequest<Request>()
      .get('authorization');
    const [scheme, encoded] = header?.split(' ') ?? [];
    // Hashing first gives timingSafeEqual equal-length inputs
    if (
      this.expected &&
      scheme?.toLowerCase() === 'basic' &&
      encoded &&
      timingSafeEqual(
        digest(Buffer.from(encoded, 'base64').toString()),
        this.expected,
      )
    ) {
      return true;
    }
    throw new UnauthorizedException();
  }
}
