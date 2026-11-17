import {
  Body,
  Controller,
  Delete,
  HttpCode,
  Patch,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { AccountService } from '@/modules/org/account/account.service';
import { OrgSession, RequireStrongAuth } from '@/modules/org/auth/decorators';
import { FactorsService } from '@/modules/org/auth/totp/factors.service';
import { FactorProofSchema } from '@/modules/org/auth/totp/totp.controller';
import { DisplayName } from '@/modules/org/common/display-text';
import { OrgApiBody } from '@/modules/org/common/org-api-body.decorator';
import { client, parse } from '@/modules/org/orgs/parse';
import {
  SESSION_COOKIE,
  SESSION_COOKIE_OPTIONS,
} from '@/modules/org/auth/session.guard';

export const DisplayNameSchema = z.object({
  // null clears it
  displayName: DisplayName.nullable(),
});

/** Static `/v1/orgs/account` routes: registered before any `:orgId` controller. */
@Controller({ path: 'orgs/account', version: '1' })
export class AccountController {
  constructor(
    private readonly account: AccountService,
    private readonly factors: FactorsService,
  ) {}

  /** The caller's own display name, shown to the other members of their orgs. */
  @Patch()
  @OrgApiBody(DisplayNameSchema)
  setDisplayName(
    @OrgSession() session: OrgSession,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<{ displayName: string | null }> {
    const { displayName } = parse(DisplayNameSchema, body);
    return this.account.setDisplayName(session.userId, displayName, client(req));
  }

  /**
   * 409 `last_admin` while the user is the last admin of any org. With TOTP,
   * also a current code or a recovery code in the body (403 `totp_code_required`).
   */
  @Delete()
  @OrgApiBody(FactorProofSchema, { required: false })
  @HttpCode(204)
  @RequireStrongAuth()
  async delete(
    @OrgSession() session: OrgSession,
    @Res({ passthrough: true }) res: Response,
    @Body() body: unknown,
  ): Promise<void> {
    const proof = parse(FactorProofSchema, body ?? {});
    await this.account.delete(session.userId, (em) =>
      this.factors.requireCurrentFactor(session.userId, proof, em),
    );
    res.clearCookie(SESSION_COOKIE, SESSION_COOKIE_OPTIONS);
  }
}
