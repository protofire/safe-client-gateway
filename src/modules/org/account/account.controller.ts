import { Controller, Delete, HttpCode, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AccountService } from '@/modules/org/account/account.service';
import { OrgSession, RequireStrongAuth } from '@/modules/org/auth/decorators';
import {
  SESSION_COOKIE,
  SESSION_COOKIE_OPTIONS,
} from '@/modules/org/auth/session.guard';

/** Static `/v1/orgs/account` routes: registered before any `:orgId` controller. */
@Controller({ path: 'orgs/account', version: '1' })
export class AccountController {
  constructor(private readonly account: AccountService) {}

  /** 409 `last_admin` while the user is the last admin of any org. */
  @Delete()
  @HttpCode(204)
  @RequireStrongAuth()
  async delete(
    @OrgSession() session: OrgSession,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.account.delete(session.userId);
    res.clearCookie(SESSION_COOKIE, SESSION_COOKIE_OPTIONS);
  }
}
