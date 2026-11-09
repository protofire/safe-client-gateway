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

  it('rejects an ORG_AMQP_QUEUE equal to the gateway AMQP_QUEUE', () => {
    const previous = process.env.AMQP_QUEUE;
    process.env.AMQP_QUEUE = 'org';
    try {
      expect(OrgConfigurationSchema.safeParse(validEnv()).success).toBe(false);
      process.env.AMQP_QUEUE = 'gateway';
      expect(OrgConfigurationSchema.safeParse(validEnv()).success).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.AMQP_QUEUE;
      else process.env.AMQP_QUEUE = previous;
    }
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
      'key id with a colon',
      JSON.stringify({ current: 'v:1', keys: { 'v:1': key(1) } }),
    ],
    [
      'key id with a space',
      JSON.stringify({ current: 'v 1', keys: { 'v 1': key(1) } }),
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

  it.each(['ORG_OIDC_ISSUER', 'ORG_OIDC_REDIRECT_URI'])(
    'rejects a plain-http %s for a non-local host (F1)',
    (name) => {
      for (const value of [
        'http://idp.example.com/',
        'http://10.0.0.5:4010/',
        'ftp://idp.example.com/',
      ]) {
        const result = OrgConfigurationSchema.safeParse({
          ...validEnv(),
          [name]: value,
        });
        expect(result.success).toBe(false);
      }
    },
  );

  it.each(['ORG_OIDC_ISSUER', 'ORG_OIDC_REDIRECT_URI'])(
    'accepts http %s on localhost, 127.0.0.1 and [::1] (dev mock)',
    (name) => {
      for (const value of [
        'http://localhost:4010/',
        'http://127.0.0.1:4010/',
        'http://[::1]:4010/',
      ]) {
        const result = OrgConfigurationSchema.safeParse({
          ...validEnv(),
          [name]: value,
        });
        expect(result.success).toBe(true);
      }
    },
  );

  it('rejects an email hash key that is not 32 bytes', () => {
    const result = OrgConfigurationSchema.safeParse({
      ...validEnv(),
      ORG_EMAIL_HASH_KEY: Buffer.alloc(8, 1).toString('base64'),
    });

    expect(result.success).toBe(false);
  });

  it.each(['*', 'https://app.example.com/', 'https://app.example.com/x'])(
    'rejects a public app URL that is not an exact origin: %s',
    (value) => {
      const result = OrgConfigurationSchema.safeParse({
        ...validEnv(),
        ORG_PUBLIC_APP_URL: value,
      });

      expect(result.success).toBe(false);
    },
  );

  it('does not require the migrator login at runtime', () => {
    const env = validEnv();

    expect(Object.keys(env).some((k) => k.includes('MIGRATOR'))).toBe(false);
    expect(OrgConfigurationSchema.safeParse(env).success).toBe(true);
  });
});
