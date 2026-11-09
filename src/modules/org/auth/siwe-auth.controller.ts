import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { AuthService, type MeDto } from '@/modules/org/auth/auth.service';
import { OrgSession, Public } from '@/modules/org/auth/decorators';
import { SESSION_COOKIE } from '@/modules/org/auth/session.guard';
import { ValidationPipe } from '@/validation/pipes/validation.pipe';

const SiweBodySchema = z.object({
  message: z.string().min(1).max(4096),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
});
type SiweBody = { message: string; signature: `0x${string}` };

const COOKIE_PATH = '/v1/orgs';

@Controller({ path: 'orgs/auth', version: '1' })
export class SiweAuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Get('nonce')
  nonce(@Req() req: Request): Promise<{ nonce: string }> {
    return this.auth.createNonce(clientIp(req));
  }

  @Public()
  @Post('siwe')
  @HttpCode(200)
  async signIn(
    @Body(new ValidationPipe(SiweBodySchema)) body: SiweBody,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ user: { id: string } }> {
    const { userId, token } = await this.auth.signInWithSiwe({
      ...body,
      ip: clientIp(req),
      userAgent: req.header('user-agent') ?? null,
    });
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: COOKIE_PATH,
      maxAge: this.auth.sessionMaxAgeSeconds * 1000,
    });
    return { user: { id: userId } };
  }

  @Post('step-up/siwe')
  @HttpCode(200)
  async stepUp(
    @OrgSession() session: OrgSession,
    @Body(new ValidationPipe(SiweBodySchema)) body: SiweBody,
    @Req() req: Request,
  ): Promise<{ ok: true }> {
    await this.auth.stepUpWithSiwe(session, { ...body, ip: clientIp(req) });
    return { ok: true };
  }

  // Public: always clears the cookie, even when the session is already gone
  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const token: unknown = req.cookies?.[SESSION_COOKIE];
    await this.auth.logout(typeof token === 'string' ? token : undefined);
    res.clearCookie(SESSION_COOKIE, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: COOKIE_PATH,
    });
  }

  @Get('me')
  me(@OrgSession() session: OrgSession): Promise<MeDto> {
    return this.auth.me(session);
  }
}

// req.ip honours the configured proxy hop count (configureOrgApp)
function clientIp(req: Request): string {
  return req.ip ?? 'unknown';
}
