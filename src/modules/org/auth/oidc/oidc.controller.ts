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
  setSessionCookie,
} from '@/modules/org/auth/session.guard';
import { client } from '@/modules/org/orgs/parse';
import { ValidationPipe } from '@/validation/pipes/validation.pipe';

// __Host- (Secure, Path=/, no Domain): sibling subdomains such as Safe Apps cannot toss or shadow it
export const OIDC_TX_COOKIE = '__Host-org_oidc_tx';
const OIDC_TX_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  // Lax: sent on the top-level GET redirect back from the issuer
  sameSite: 'lax',
  path: '/',
} as const;

export const AuthorizeQuerySchema = z.object({
  connection: z.enum(['email', 'google-oauth2']),
  returnTo: z.string().optional(),
});
export type AuthorizeQuery = { connection: OidcConnection; returnTo?: string };

/** The browser-binding cookie the callback checks against the state record. */
export function setOidcTxCookie(res: Response, tx: string): void {
  res.cookie(OIDC_TX_COOKIE, tx, {
    ...OIDC_TX_COOKIE_OPTIONS,
    maxAge: OIDC_TX_TTL_SECONDS * 1000,
  });
}

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
    const started = await this.oidc.start({
      connection: query.connection,
      returnTo: query.returnTo,
      ip: client(req).ip,
    });
    setOidcTxCookie(res, started.tx);
    res.redirect(302, started.redirectUrl);
  }

  /** Always a 302: to returnTo on success, else with `?orgAuthError=<code>` (item 5). */
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
      error: query.error,
      code: query.code,
      state: query.state,
      tx: req.cookies?.[OIDC_TX_COOKIE],
      sessionToken: req.cookies?.[SESSION_COOKIE],
      ip: client(req).ip,
      userAgent: req.header('user-agent') ?? null,
    });
    if (token) setSessionCookie(res, token, this.oidc.sessionMaxAgeSeconds);
    res.redirect(302, redirectUrl);
  }
}
