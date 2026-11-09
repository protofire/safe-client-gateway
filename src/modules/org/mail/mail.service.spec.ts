import type { IConfigurationService } from '@/config/configuration.service.interface';
import type { INetworkService } from '@/datasources/network/network.service.interface';
import type { ILoggingService } from '@/logging/logging.interface';
import { MailService } from '@/modules/org/mail/mail.service';

const mail = {
  orgName: 'Acme',
  inviterLabel: 'An organization admin',
  acceptUrl: 'https://app.example.com/organizations/invite#token=secret-token',
};

function service(isDevelopment: unknown): {
  mail: MailService;
  logger: jest.Mocked<ILoggingService>;
} {
  const config = {
    get: (k: string): unknown =>
      k === 'application.isDevelopment' ? isDevelopment : undefined,
  } as unknown as IConfigurationService;
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as unknown as jest.Mocked<ILoggingService>;
  const network = { post: jest.fn() } as unknown as INetworkService;
  return { mail: new MailService(network, config, logger), logger };
}

describe('MailService without an API key', () => {
  it('logs the accept URL only when application.isDevelopment is true', async () => {
    const { mail: m, logger } = service(true);
    await m.sendInvite('a@example.com', mail);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining(mail.acceptUrl),
    );
  });

  it.each([false, undefined, 'true'])(
    'never logs the token and reports mail as not configured (isDevelopment %p)',
    async (flag) => {
      const { mail: m, logger } = service(flag);
      await expect(m.sendInvite('a@example.com', mail)).rejects.toThrow(
        'org mail is not configured',
      );
      for (const fn of [logger.info, logger.warn, logger.error, logger.debug]) {
        expect(JSON.stringify(fn.mock.calls)).not.toContain('secret-token');
      }
    },
  );
});
