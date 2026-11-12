import type { IConfigurationService } from '@/config/configuration.service.interface';
import type { INetworkService } from '@/datasources/network/network.service.interface';
import type { ILoggingService } from '@/logging/logging.interface';
import {
  mailFailureReason,
  MailService,
} from '@/modules/org/mail/mail.service';

const mail = {
  orgName: 'Acme',
  inviterLabel: 'An organization admin',
  acceptUrl: 'https://app.example.com/organizations/invite#token=secret-token',
};

function service(logLinks: unknown): {
  mail: MailService;
  logger: jest.Mocked<ILoggingService>;
} {
  const config = {
    get: (k: string): unknown =>
      k === 'org.mail.logLinks' ? logLinks : undefined,
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
  it('logs the accept URL only when org.mail.logLinks is true', async () => {
    const { mail: m, logger } = service(true);
    await m.sendInvite('a@example.com', mail);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining(mail.acceptUrl),
    );
  });

  it.each([false, undefined, 'true'])(
    'never logs the token and reports mail as not configured (logLinks %p)',
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

describe('MailService sign-in codes without an API key', () => {
  it('logs the code only when org.mail.logLinks is true', async () => {
    const { mail: m, logger } = service(true);
    await m.sendSignInCode('a@example.com', '12345678');
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('12345678'),
    );
  });

  it('never logs the code otherwise', async () => {
    const { mail: m, logger } = service(false);
    await expect(m.sendSignInCode('a@example.com', '12345678')).rejects.toThrow(
      'org mail is not configured',
    );
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain('12345678');
  });
});

describe('mailFailureReason', () => {
  it('reports the HTTP status of a provider answer, never its body', () => {
    const error = Object.assign(new Error(), {
      response: { status: 422 },
      data: { message: 'to: alice@example.com is invalid' },
    });
    expect(mailFailureReason(error)).toBe('HTTP 422');
  });

  it('falls back to the message, then the error class', () => {
    expect(mailFailureReason(new Error('org mail is not configured'))).toBe(
      'org mail is not configured',
    );
    expect(mailFailureReason(new TypeError())).toBe('TypeError');
    expect(mailFailureReason('x')).toBe('unknown error');
  });
});
