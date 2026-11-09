import { Body, Controller, Delete, HttpCode, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { OrgSession, RequireStrongAuth } from '@/modules/org/auth/decorators';
import { FactorsService } from '@/modules/org/auth/totp/factors.service';
import { ValidationPipe } from '@/validation/pipes/validation.pipe';

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
  constructor(private readonly factors: FactorsService) {}

  @Post('totp/enroll')
  @HttpCode(200)
  enroll(
    @OrgSession() session: OrgSession,
  ): Promise<{ secret: string; otpauthUri: string }> {
    return this.factors.enroll(session);
  }

  @Post('totp/confirm')
  @HttpCode(200)
  confirm(
    @OrgSession() session: OrgSession,
    @Body(new ValidationPipe(CodeSchema)) body: { code: string },
    @Req() req: Request,
  ): Promise<{ recoveryCodes: Array<string> }> {
    return this.factors.confirm(session, body.code, client(req));
  }

  @Post('step-up/totp')
  @HttpCode(200)
  async stepUp(
    @OrgSession() session: OrgSession,
    @Body(new ValidationPipe(StepUpSchema))
    body: { code?: string; recoveryCode?: string },
    @Req() req: Request,
  ): Promise<{ ok: true }> {
    await this.factors.stepUp(session, body, client(req));
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

// req.ip honours the configured proxy hop count (configureOrgApp)
function client(req: Request): { ip: string; userAgent: string | null } {
  return {
    ip: req.ip ?? 'unknown',
    userAgent: req.header('user-agent') ?? null,
  };
}
