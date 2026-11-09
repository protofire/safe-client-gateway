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
import { type InviteMail, inviteTemplate } from '@/modules/org/mail/templates';

/** Transactional mail through the Resend HTTP API (`POST {baseUrl}/emails`). */
@Injectable()
export class MailService {
  private readonly apiKey: string | undefined;
  private readonly from: string | undefined;
  private readonly baseUrl: string | undefined;
  private readonly isProduction: boolean;

  constructor(
    @Inject(NetworkService) private readonly network: INetworkService,
    @Inject(IConfigurationService) config: IConfigurationService,
    @Inject(LoggingService) private readonly logger: ILoggingService,
  ) {
    this.apiKey = config.get<string>('org.mail.apiKey') || undefined;
    this.from = config.get<string>('org.mail.from');
    this.baseUrl = config.get<string>('org.mail.baseUrl');
    this.isProduction =
      process.env.NODE_ENV === 'production' ||
      config.get<boolean>('application.isProduction') === true;
  }

  async sendInvite(to: string, mail: InviteMail): Promise<void> {
    if (!this.apiKey) {
      // the URL carries the invitation token: never logged in production
      if (this.isProduction) throw new Error('ORG_MAIL_API_KEY is not set');
      this.logger.info(
        `[org mail] no ORG_MAIL_API_KEY, invite link: ${mail.acceptUrl}`,
      );
      return;
    }
    await this.network.post({
      url: `${this.baseUrl!.replace(/\/+$/, '')}/emails`,
      data: { from: this.from, to: [to], ...inviteTemplate(mail) },
      networkRequest: { headers: { Authorization: `Bearer ${this.apiKey}` } },
    });
  }
}
