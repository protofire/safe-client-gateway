import {
  Body,
  Controller,
  Delete,
  HttpCode,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService } from '@/modules/org/auth/auth.service';
import { z } from 'zod';
import { OrgSession, RequireStrongAuth } from '@/modules/org/auth/decorators';
import { setSessionCookie } from '@/modules/org/auth/session.guard';
import { FactorsService } from '@/modules/org/auth/totp/factors.service';
import { client } from '@/modules/org/orgs/parse';
import { ValidationPipe } from '@/validation/pipes/validation.pipe';
import { OrgApiBody } from '@/modules/org/common/org-api-body.decorator';

const CodeSchema = z.object({ code: z.string().min(1).max(16) });
const StepUpSchema = z
  .object({
    code: z.string().min(1).max(16).optional(),
    recoveryCode: z.string().min(1).max(64).optional(),
  })
  .refine((b) => (b.code === undefined) !== (b.recoveryCode === undefined), {
    error: 'Give exactly one of code and recoveryCode',
  });

@Controller({ path: 'orgs/auth', version: '1' })
export class TotpController {
  constructor(
    private readonly factors: FactorsService,
    private readonly auth: AuthService,
  ) {}

  @Post('totp/enroll')
  @HttpCode(200)
  enroll(
    @OrgSession() session: OrgSession,
  ): Promise<{ secret: string; otpauthUri: string }> {
    return this.factors.enroll(session);
  }

  @Post('totp/confirm')
  @OrgApiBody(CodeSchema)
  @HttpCode(200)
  async confirm(
    @OrgSession() session: OrgSession,
    @Body(new ValidationPipe(CodeSchema)) body: { code: string },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ recoveryCodes: Array<string> }> {
    const { recoveryCodes, token } = await this.factors.confirm(
      session,
      body.code,
      client(req),
    );
    setSessionCookie(res, token, this.auth.sessionMaxAgeSeconds);
    return { recoveryCodes };
  }

  @Post('step-up/totp')
  @OrgApiBody(StepUpSchema)
  @HttpCode(200)
  async stepUp(
    @OrgSession() session: OrgSession,
    @Body(new ValidationPipe(StepUpSchema))
    body: { code?: string; recoveryCode?: string },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ ok: true }> {
    const token = await this.factors.stepUp(session, body, client(req));
    setSessionCookie(res, token, this.auth.sessionMaxAgeSeconds);
    return { ok: true };
  }

  @Delete('totp')
  @HttpCode(204)
  @RequireStrongAuth()
  async remove(
    @OrgSession() session: OrgSession,
    @Req() req: Request,
  ): Promise<void> {
    await this.factors.remove(session, client(req));
  }
}
