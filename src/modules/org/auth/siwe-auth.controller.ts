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
import {
  SESSION_COOKIE,
  SESSION_COOKIE_OPTIONS,
  setSessionCookie,
} from '@/modules/org/auth/session.guard';
import { client } from '@/modules/org/orgs/parse';
import { ValidationPipe } from '@/validation/pipes/validation.pipe';

export const SiweBodySchema = z.object({
  message: z.string().min(1).max(4096),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
});
export type SiweBody = { message: string; signature: `0x${string}` };

@Controller({ path: 'orgs/auth', version: '1' })
export class SiweAuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Get('nonce')
  nonce(@Req() req: Request): Promise<{ nonce: string }> {
    return this.auth.createNonce(client(req).ip);
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
      ip: client(req).ip,
      userAgent: req.header('user-agent') ?? null,
    });
    setSessionCookie(res, token, this.auth.sessionMaxAgeSeconds);
    return { user: { id: userId } };
  }

  @Post('step-up/siwe')
  @HttpCode(200)
  async stepUp(
    @OrgSession() session: OrgSession,
    @Body(new ValidationPipe(SiweBodySchema)) body: SiweBody,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ ok: true }> {
    const token = await this.auth.stepUpWithSiwe(session, {
      ...body,
      ip: client(req).ip,
    });
    setSessionCookie(res, token, this.auth.sessionMaxAgeSeconds);
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
    res.clearCookie(SESSION_COOKIE, SESSION_COOKIE_OPTIONS);
  }

  @Get('me')
  me(@OrgSession() session: OrgSession): Promise<MeDto> {
    return this.auth.me(session);
  }
}
