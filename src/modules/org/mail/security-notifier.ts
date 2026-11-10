import { Inject, Injectable } from '@nestjs/common';
import {
  type ILoggingService,
  LoggingService,
} from '@/logging/logging.interface';
import { FieldEncryptionService } from '@/modules/org/crypto/field-encryption.service';
import { OrgTransaction } from '@/modules/org/db/org-transaction';
import { MailService } from '@/modules/org/mail/mail.service';
import type { SecurityNotice } from '@/modules/org/mail/templates';
import type { Permission } from '@/modules/org/permissions/permissions';

/** Who counts as an admin for notices: holders of role assignment (permissions as data). */
export const ADMIN_PERMISSION: Permission = 'roles.assign';

/**
 * Security notices (Nick, 2026-11-10) to every active admin of the org with
 * an email identity, plus the affected users. Call after commit: a mail
 * failure is logged and never fails the action.
 */
@Injectable()
export class SecurityNotifier {
  constructor(
    private readonly tx: OrgTransaction,
    private readonly encryption: FieldEncryptionService,
    private readonly mail: MailService,
    @Inject(LoggingService) private readonly logger: ILoggingService,
  ) {}

  async notify(
    orgId: string,
    notice: Omit<SecurityNotice, 'orgName'>,
    affectedUserIds: Array<string> = [],
  ): Promise<void> {
    let recipients: Array<string>;
    let orgName: string;
    try {
      ({ recipients, orgName } = await this.recipients(orgId, affectedUserIds));
    } catch (error) {
      this.fail(notice.kind, error);
      return;
    }
    for (const to of recipients) {
      try {
        await this.mail.sendSecurityNotice(to, { ...notice, orgName });
      } catch (error) {
        this.fail(notice.kind, error);
      }
    }
  }

  private async recipients(
    orgId: string,
    affectedUserIds: Array<string>,
  ): Promise<{ recipients: Array<string>; orgName: string }> {
    return this.tx.runInOrgTx(async (em) => {
      // first email identity per user; admins of an active user only
      const rows: Array<{ email: string }> = await em.query(
        `SELECT DISTINCT ON (i.user_id) i.email_encrypted AS email
         FROM identities i
         WHERE i.kind = 'oidc' AND i.email_encrypted IS NOT NULL
           AND (i.user_id = ANY($2::uuid[]) OR i.user_id IN (
             SELECT m.user_id FROM members m
             JOIN users u ON u.id = m.user_id AND u.status = 'active'
             JOIN role_bindings rb ON rb.member_id = m.id AND rb.scope = 'org'
             JOIN roles r ON r.id = rb.role_id AND (r.org_id IS NULL OR r.org_id = m.org_id)
             WHERE m.org_id = $1 AND m.status = 'active' AND $3 = ANY(r.permissions)))
         ORDER BY i.user_id, i.created_at, i.id`,
        [orgId, affectedUserIds, ADMIN_PERMISSION],
      );
      const [org]: Array<{ name: string }> = await em.query(
        `SELECT name FROM organizations WHERE id = $1`,
        [orgId],
      );
      return {
        recipients: rows.map((r) => this.encryption.decrypt(r.email)),
        orgName: org?.name ?? '',
      };
    });
  }

  private fail(kind: string, error: unknown): void {
    this.logger.error(
      `org security notice (${kind}) failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
