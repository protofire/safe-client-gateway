import {
  Body,
  Controller,
  Delete,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AccountService } from '@/modules/org/account/account.service';
import { AuthService } from '@/modules/org/auth/auth.service';
import { OrgSession, RequireStrongAuth } from '@/modules/org/auth/decorators';
import {
  clearEmailTxCookie,
  EMAIL_TX_COOKIE,
  EmailStartBodySchema,
  EmailVerifyBodySchema,
  setEmailTxCookie,
  type EmailStartBody,
  type EmailVerifyBody,
} from '@/modules/org/auth/email-otp/email-otp.controller';
import { EmailOtpService } from '@/modules/org/auth/email-otp/email-otp.service';
import {
  AuthorizeQuerySchema,
  setOidcTxCookie,
  type AuthorizeQuery,
} from '@/modules/org/auth/oidc/oidc.controller';
import { OidcService } from '@/modules/org/auth/oidc/oidc.service';
import {
  SiweBodySchema,
  type SiweBody,
} from '@/modules/org/auth/siwe-auth.controller';
import { client } from '@/modules/org/orgs/parse';
import { ValidationPipe } from '@/validation/pipes/validation.pipe';
import { OrgApiBody } from '@/modules/org/common/org-api-body.decorator';

/**
 * Task 12 / A6: adding or removing a sign-in method needs fresh strong auth
 * (only the first identity is enrolled without it, at sign-up).
 */
@Controller({ path: 'orgs/account', version: '1' })
export class LinkIdentityController {
  constructor(
    private readonly auth: AuthService,
    private readonly oidc: OidcService,
    private readonly emailOtp: EmailOtpService,
    private readonly account: AccountService,
  ) {}

  /** 409 `identity_taken` if the wallet belongs to another user. */
  @Post('link/siwe')
  @OrgApiBody(SiweBodySchema)
  @HttpCode(200)
  @RequireStrongAuth()
  async linkSiwe(
    @OrgSession() session: OrgSession,
    @Body(new ValidationPipe(SiweBodySchema)) body: SiweBody,
    @Req() req: Request,
  ): Promise<{ ok: true }> {
    await this.auth.linkWallet(session, { ...body, ...client(req) });
    return { ok: true };
  }

  /**
   * Same flow as sign-in; the shared callback attaches the identity to this
   * session's user. POST (CsrfGuard), answering the URL for the browser to
   * open, since it creates the state record and sets `__Host-org_oidc_tx`.
   */
  @Post('link/oidc/authorize')
  @OrgApiBody(AuthorizeQuerySchema)
  @HttpCode(200)
  @RequireStrongAuth()
  async linkOidc(
    @OrgSession() session: OrgSession,
    @Body(new ValidationPipe(AuthorizeQuerySchema)) body: AuthorizeQuery,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ redirectUrl: string }> {
    const started = await this.oidc.start({
      returnTo: body.returnTo,
      ip: client(req).ip,
      sessionId: session.sessionId,
    });
    setOidcTxCookie(res, started.tx);
    return { redirectUrl: started.redirectUrl };
  }

  /**
   * Mails a code to the address to link (no sign-in gate: the caller has
   * fresh strong auth; send limits apply). Always `{ ok: true }`.
   */
  @Post('link/email/start')
  @OrgApiBody(EmailStartBodySchema)
  @HttpCode(200)
  @RequireStrongAuth()
  async linkEmailStart(
    @OrgSession() session: OrgSession,
    @Body(new ValidationPipe(EmailStartBodySchema)) body: EmailStartBody,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ ok: true }> {
    const { tx } = await this.emailOtp.start({
      email: body.email,
      ip: client(req).ip,
      session,
    });
    setEmailTxCookie(res, tx);
    return { ok: true };
  }

  /**
   * Bound to the session and browser that started the link. 401
   * `code_invalid`; 409 `identity_taken` if the address is another user's.
   */
  @Post('link/email/verify')
  @OrgApiBody(EmailVerifyBodySchema)
  @HttpCode(200)
  async linkEmailVerify(
    @OrgSession() session: OrgSession,
    @Body(new ValidationPipe(EmailVerifyBodySchema)) body: EmailVerifyBody,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ ok: true }> {
    await this.emailOtp.link(
      session,
      body.code,
      req.cookies?.[EMAIL_TX_COOKIE],
      client(req),
    );
    clearEmailTxCookie(res);
    return { ok: true };
  }

  /** 409 `last_identity` for the only identity. */
  @Delete('identities/:identityId')
  @HttpCode(204)
  @RequireStrongAuth()
  async removeIdentity(
    @OrgSession() session: OrgSession,
    @Param('identityId') identityId: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.account.removeIdentity(session, identityId, client(req));
  }
}
