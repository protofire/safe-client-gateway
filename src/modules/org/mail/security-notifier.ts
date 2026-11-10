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

type Recipient = { email: string; inOrg: boolean };

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

  /**
   * `adminOrgIds`: whose admins hear about it (default: `orgId`'s); each
   * recipient gets one mail. Wallet-only admins have no address and get no
   * mail (known gap). Mails go out concurrently: latency is the slowest
   * send, not the sum.
   */
  async notify(
    orgId: string,
    notice: Omit<SecurityNotice, 'orgName'>,
    affectedUserIds: Array<string> = [],
    adminOrgIds: Array<string> = [orgId],
  ): Promise<void> {
    let recipients: Array<Recipient>;
    let orgName: string;
    try {
      ({ recipients, orgName } = await this.recipients(
        orgId,
        affectedUserIds,
        adminOrgIds,
      ));
    } catch (error) {
      this.fail(notice.kind, error);
      return;
    }
    const results = await Promise.allSettled(
      recipients.map(({ email, inOrg }) =>
        this.mail.sendSecurityNotice(email, {
          ...notice,
          orgName,
          // a cross-org reset must not name the acting org to other orgs' admins
          crossOrg: notice.kind === 'factors_reset' && !inOrg,
        }),
      ),
    );
    for (const r of results) {
      if (r.status === 'rejected') this.fail(notice.kind, r.reason);
    }
  }

  private async recipients(
    orgId: string,
    affectedUserIds: Array<string>,
    adminOrgIds: Array<string>,
  ): Promise<{ recipients: Array<Recipient>; orgName: string }> {
    return this.tx.runInOrgTx(async (em) => {
      // first email identity per user; admins of an active user only
      const rows: Array<{ email: string; inOrg: boolean }> = await em.query(
        `SELECT DISTINCT ON (i.user_id) i.email_encrypted AS email,
                EXISTS (SELECT 1 FROM members om
                        WHERE om.user_id = i.user_id AND om.org_id = $4
                          AND om.status = 'active') AS "inOrg"
         FROM identities i
         WHERE i.kind = 'oidc' AND i.email_encrypted IS NOT NULL
           AND (i.user_id = ANY($1::uuid[]) OR i.user_id IN (
             SELECT m.user_id FROM members m
             JOIN users u ON u.id = m.user_id AND u.status = 'active'
             JOIN role_bindings rb ON rb.member_id = m.id AND rb.scope = 'org'
             JOIN roles r ON r.id = rb.role_id AND (r.org_id IS NULL OR r.org_id = m.org_id)
             WHERE m.org_id = ANY($3::uuid[]) AND m.status = 'active' AND $2 = ANY(r.permissions)))
         ORDER BY i.user_id, i.created_at, i.id`,
        [affectedUserIds, ADMIN_PERMISSION, adminOrgIds, orgId],
      );
      const [org]: Array<{ name: string }> = await em.query(
        `SELECT name FROM organizations WHERE id = $1`,
        [orgId],
      );
      return {
        recipients: rows.map((r) => ({
          email: this.encryption.decrypt(r.email),
          inOrg: r.inOrg,
        })),
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
