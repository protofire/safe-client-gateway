import { Controller, Get, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { Public } from '@/modules/org/auth/decorators';
import type { OidcConnection } from '@/modules/org/auth/oidc/oidc.client';
import {
  OIDC_TX_TTL_SECONDS,
  OidcService,
} from '@/modules/org/auth/oidc/oidc.service';
import {
  SESSION_COOKIE,
  SESSION_COOKIE_OPTIONS,
} from '@/modules/org/auth/session.guard';
import { ValidationPipe } from '@/validation/pipes/validation.pipe';

export const OIDC_TX_COOKIE = 'org_oidc_tx';
const OIDC_TX_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  // Lax: sent on the top-level GET redirect back from the issuer
  sameSite: 'lax',
  path: '/v1/orgs/auth/oidc',
} as const;

const AuthorizeQuerySchema = z.object({
  connection: z.enum(['email', 'google-oauth2']),
  returnTo: z.string().optional(),
});
type AuthorizeQuery = { connection: OidcConnection; returnTo?: string };

@Controller({ path: 'orgs/auth/oidc', version: '1' })
export class OidcController {
  constructor(private readonly oidc: OidcService) {}

  @Public()
  @Get('authorize')
  async authorize(
    @Query(new ValidationPipe(AuthorizeQuerySchema)) query: AuthorizeQuery,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const { redirectUrl, tx } = await this.oidc.start({
      connection: query.connection,
      returnTo: query.returnTo,
      ip: clientIp(req),
    });
    res.cookie(OIDC_TX_COOKIE, tx, {
      ...OIDC_TX_COOKIE_OPTIONS,
      maxAge: OIDC_TX_TTL_SECONDS * 1000,
    });
    res.redirect(302, redirectUrl);
  }

  @Public()
  @Get('callback')
  async callback(
    @Query() query: Record<string, unknown>,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    // cleared on every outcome; the error filter keeps headers already set
    res.clearCookie(OIDC_TX_COOKIE, OIDC_TX_COOKIE_OPTIONS);
    const { token, redirectUrl } = await this.oidc.complete({
      code: query.code,
      state: query.state,
      tx: req.cookies?.[OIDC_TX_COOKIE],
      ip: clientIp(req),
      userAgent: req.header('user-agent') ?? null,
    });
    res.cookie(SESSION_COOKIE, token, {
      ...SESSION_COOKIE_OPTIONS,
      maxAge: this.oidc.sessionMaxAgeSeconds * 1000,
    });
    res.redirect(302, redirectUrl);
  }
}

// req.ip honours the configured proxy hop count (configureOrgApp)
function clientIp(req: Request): string {
  return req.ip ?? 'unknown';
}
