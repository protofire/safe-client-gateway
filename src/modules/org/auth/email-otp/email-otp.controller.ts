import { Body, Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { Public } from '@/modules/org/auth/decorators';
import {
  EMAIL_CODE_TTL_SECONDS,
  EmailOtpService,
} from '@/modules/org/auth/email-otp/email-otp.service';
import { setSessionCookie } from '@/modules/org/auth/session.guard';
import { OrgApiBody } from '@/modules/org/common/org-api-body.decorator';
import { normalizeEmail } from '@/modules/org/crypto/hashing';
import { client } from '@/modules/org/orgs/parse';
import { ValidationPipe } from '@/validation/pipes/validation.pipe';

// __Host- (Secure, Path=/, no Domain): sibling subdomains cannot toss or shadow it
export const EMAIL_TX_COOKIE = '__Host-org_email_tx';
const EMAIL_TX_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: '/',
} as const;

export const EmailStartBodySchema = z.object({
  email: z
    .string()
    .max(254)
    .refine((v) => z.email().safeParse(normalizeEmail(v)).success, {
      error: 'Must be an email address',
    }),
});
export type EmailStartBody = { email: string };

export const EmailVerifyBodySchema = z.object({
  code: z.string().regex(/^\d{8}$/),
});
export type EmailVerifyBody = { code: string };

/** The browser-binding cookie: the code only works in the browser that asked for it. */
export function setEmailTxCookie(res: Response, tx: string): void {
  res.cookie(EMAIL_TX_COOKIE, tx, {
    ...EMAIL_TX_COOKIE_OPTIONS,
    maxAge: EMAIL_CODE_TTL_SECONDS * 1000,
  });
}

export function clearEmailTxCookie(res: Response): void {
  res.clearCookie(EMAIL_TX_COOKIE, EMAIL_TX_COOKIE_OPTIONS);
}

@Controller({ path: 'orgs/auth/email', version: '1' })
export class EmailOtpController {
  constructor(private readonly emailOtp: EmailOtpService) {}

  /**
   * Always `{ ok: true }` (429 only for this IP's own rate): the code is
   * mailed afterwards, and only to an address that may receive one.
   */
  @Public()
  @Post('start')
  @OrgApiBody(EmailStartBodySchema)
  @HttpCode(200)
  async start(
    @Body(new ValidationPipe(EmailStartBodySchema)) body: EmailStartBody,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ ok: true }> {
    const { tx } = await this.emailOtp.start({
      email: body.email,
      ip: client(req).ip,
    });
    setEmailTxCookie(res, tx);
    return { ok: true };
  }

  /**
   * Session (never strong). `linkHint`: another account uses this email with
   * another sign-in method; the UI suggests linking.
   */
  @Public()
  @Post('verify')
  @OrgApiBody(EmailVerifyBodySchema)
  @HttpCode(200)
  async verify(
    @Body(new ValidationPipe(EmailVerifyBodySchema)) body: EmailVerifyBody,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ user: { id: string }; linkHint: boolean }> {
    const { userId, token, linkHint } = await this.emailOtp.signIn(
      body.code,
      req.cookies?.[EMAIL_TX_COOKIE],
      client(req),
    );
    clearEmailTxCookie(res);
    setSessionCookie(res, token, this.emailOtp.sessionMaxAgeSeconds);
    return { user: { id: userId }, linkHint };
  }
}
