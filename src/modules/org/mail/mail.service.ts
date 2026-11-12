import { Inject, Injectable } from '@nestjs/common';
import { IConfigurationService } from '@/config/configuration.service.interface';
import {
  type INetworkService,
  NetworkService,
} from '@/datasources/network/network.service.interface';
import {
  type ILoggingService,
  LoggingService,
} from '@/logging/logging.interface';
import {
  type InviteMail,
  inviteTemplate,
  type MailContent,
  type SecurityNotice,
  securityNoticeTemplate,
  signInCodeTemplate,
} from '@/modules/org/mail/templates';

/** Transactional mail through the Resend HTTP API (`POST {baseUrl}/emails`). */
@Injectable()
export class MailService {
  private readonly apiKey: string | undefined;
  private readonly from: string | undefined;
  private readonly baseUrl: string | undefined;
  private readonly logLinks: boolean;

  constructor(
    @Inject(NetworkService) private readonly network: INetworkService,
    @Inject(IConfigurationService) config: IConfigurationService,
    @Inject(LoggingService) private readonly logger: ILoggingService,
  ) {
    this.apiKey = config.get<string>('org.mail.apiKey') || undefined;
    this.from = config.get<string>('org.mail.from');
    this.baseUrl = config.get<string>('org.mail.baseUrl');
    this.logLinks = config.get<boolean>('org.mail.logLinks') === true;
  }

  async sendInvite(to: string, mail: InviteMail): Promise<void> {
    if (!this.apiKey) {
      // the URL carries the invitation token: logged only on explicit opt-in (ORG_MAIL_LOG_LINKS, never in production)
      if (!this.logLinks) {
        throw new Error('org mail is not configured (ORG_MAIL_API_KEY)');
      }
      this.logger.info(
        `[org mail] no ORG_MAIL_API_KEY, invite link: ${mail.acceptUrl}`,
      );
      return;
    }
    await this.send(to, inviteTemplate(mail));
  }

  async sendSignInCode(to: string, code: string): Promise<void> {
    if (!this.apiKey) {
      // the code signs in: logged only on explicit opt-in (ORG_MAIL_LOG_LINKS, never in production)
      if (!this.logLinks) {
        throw new Error('org mail is not configured (ORG_MAIL_API_KEY)');
      }
      this.logger.info(`[org mail] no ORG_MAIL_API_KEY, sign-in code: ${code}`);
      return;
    }
    await this.send(to, signInCodeTemplate(code));
  }

  async sendSecurityNotice(to: string, notice: SecurityNotice): Promise<void> {
    if (!this.apiKey) {
      throw new Error('org mail is not configured (ORG_MAIL_API_KEY)');
    }
    await this.send(to, securityNoticeTemplate(notice));
  }

  private async send(to: string, content: MailContent): Promise<void> {
    await this.network.post({
      url: `${this.baseUrl!.replace(/\/+$/, '')}/emails`,
      data: { from: this.from, to: [to], ...content },
      networkRequest: { headers: { Authorization: `Bearer ${this.apiKey}` } },
    });
  }
}
