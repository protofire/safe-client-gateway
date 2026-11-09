import { OrgConfigurationSchema } from '@/config/org/org-configuration.schema';

const key = (fill: number): string => Buffer.alloc(32, fill).toString('base64');

function validEnv(): Record<string, string> {
  return {
    ORG_PUBLIC_APP_URL: 'https://app.example.com',
    ORG_DB_HOST: 'localhost',
    ORG_DB_PORT: '5432',
    ORG_DB_NAME: 'org',
    ORG_DB_APP_USERNAME: 'org_app',
    ORG_DB_APP_PASSWORD: 'placeholder',
    ORG_DB_MIGRATOR_USERNAME: 'org_migrator',
    ORG_DB_MIGRATOR_PASSWORD: 'placeholder',
    ORG_REDIS_HOST: 'localhost',
    ORG_AMQP_URL: 'amqp://localhost:5672',
    ORG_AMQP_EXCHANGE_NAME: 'safe-transaction-service-events',
    ORG_AMQP_QUEUE: 'org',
    ORG_ENCRYPTION_KEYS: JSON.stringify({
      current: 'v1',
      keys: { v1: key(1) },
    }),
    ORG_EMAIL_HASH_KEY: key(2),
    ORG_OIDC_ISSUER: 'https://idp.example.com/',
    ORG_OIDC_CLIENT_ID: 'client',
    ORG_OIDC_CLIENT_SECRET: 'placeholder',
    ORG_OIDC_REDIRECT_URI: 'https://api.example.com/v1/orgs/auth/oidc/callback',
    ORG_OIDC_POST_LOGIN_REDIRECT: 'https://app.example.com/',
    ORG_MAIL_API_KEY: 'placeholder',
    ORG_MAIL_FROM: 'noreply@example.com',
    ORG_MAIL_BASE_URL: 'https://mail.example.com',
    ORG_PRICES_PROVIDER_API_KEY: 'placeholder',
    BLOCKLIST_ENCRYPTED_DATA: 'placeholder',
    BLOCKLIST_SECRET_KEY: 'placeholder',
    BLOCKLIST_SECRET_SALT: 'placeholder',
  };
}

describe('OrgConfigurationSchema', () => {
  it('accepts a config without JWT_SECRET, AUTH_TOKEN, RELAY_* and POSTGRES_*', () => {
    const env = validEnv();
    for (const name of Object.keys(env)) {
      expect(name).not.toMatch(/^(JWT_|AUTH_TOKEN|RELAY_|POSTGRES_)/);
    }

    expect(OrgConfigurationSchema.safeParse(env).success).toBe(true);
  });

  it('does not require gateway secrets even when they are absent from a minimal env', () => {
    const result = OrgConfigurationSchema.safeParse(validEnv());

    expect(result.success).toBe(true);
  });

  it.each([
    ['not JSON', 'nope'],
    [
      'current key missing',
      JSON.stringify({ current: 'v2', keys: { v1: key(1) } }),
    ],
    [
      'key shorter than 32 bytes',
      JSON.stringify({
        current: 'v1',
        keys: { v1: Buffer.alloc(16, 1).toString('base64') },
      }),
    ],
    [
      'key not base64',
      JSON.stringify({ current: 'v1', keys: { v1: 'not base64 !!' } }),
    ],
  ])('rejects encryption keys: %s', (_, value) => {
    const result = OrgConfigurationSchema.safeParse({
      ...validEnv(),
      ORG_ENCRYPTION_KEYS: value,
    });

    expect(result.success).toBe(false);
  });

  it('rejects an email hash key that is not 32 bytes', () => {
    const result = OrgConfigurationSchema.safeParse({
      ...validEnv(),
      ORG_EMAIL_HASH_KEY: Buffer.alloc(8, 1).toString('base64'),
    });

    expect(result.success).toBe(false);
  });

  it('rejects a non-URL public app URL', () => {
    const result = OrgConfigurationSchema.safeParse({
      ...validEnv(),
      ORG_PUBLIC_APP_URL: '*',
    });

    expect(result.success).toBe(false);
  });
});
