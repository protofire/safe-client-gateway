import { z } from 'zod';

const KEY_BYTES = 32;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function isKey(value: string): boolean {
  return (
    BASE64.test(value) && Buffer.from(value, 'base64').length === KEY_BYTES
  );
}

const keyBytes = z
  .string()
  .refine(isKey, { error: 'Must be base64 encoding of exactly 32 bytes' });

const encryptionKeys = z.string().superRefine((value, ctx) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Must be valid JSON' });
    return;
  }
  const result = z
    // ids are written into the ciphertext blob, where ':' is the separator
    .object({
      current: z.string(),
      keys: z.record(z.string().regex(/^[A-Za-z0-9_-]+$/), keyBytes),
    })
    .safeParse(parsed);
  if (!result.success) {
    ctx.addIssue({
      code: 'custom',
      message:
        'Must be { "current": "<id>", "keys": { "<id>": "<base64 32 bytes>" } }',
    });
    return;
  }
  if (!(result.data.current in result.data.keys)) {
    ctx.addIssue({
      code: 'custom',
      message: '"current" must name an entry in "keys"',
    });
  }
});

const port = z.coerce.number().int().min(1).max(65535);
const seconds = z.coerce.number().int().min(1).optional();
const url = z.url();
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
// https, or http only on a loopback host (local OIDC mock)
const httpsUrl = url.refine(
  (v) => {
    const { protocol, hostname } = new URL(v);
    return (
      protocol === 'https:' ||
      (protocol === 'http:' && LOCAL_HOSTS.has(hostname))
    );
  },
  { error: 'Must be https (plain http only for localhost)' },
);

/**
 * Environment contract of cgw-org. Deliberately independent of
 * RootConfigurationSchema: no JWT_SECRET, AUTH_TOKEN, RELAY_*, FCM or gateway
 * POSTGRES_* so a leaked org process holds none of the gateway secrets.
 */
export const OrgConfigurationSchema = z
  .object({
    ORG_APPLICATION_PORT: port.optional(),
    // Validated as a non-negative integer at bootstrap (configureOrgApp)
    ORG_TRUST_PROXY_HOPS: z.string().optional(),
    // Exact origin allowed by CORS; a wildcard would be unsafe with credentials
    ORG_PUBLIC_APP_URL: url.refine(
      (v) => URL.canParse(v) && new URL(v).origin === v,
      {
        error:
          'Must be an exact origin: no trailing slash, path, query or hash',
      },
    ),

    ORG_DB_HOST: z.string().min(1),
    ORG_DB_PORT: port,
    ORG_DB_NAME: z.string().min(1),
    ORG_DB_SSL: z.enum(['true', 'false']).optional(),
    // Runtime login: not the owner, no BYPASSRLS. The owner (migrator) login is
    // read only by the one-off migration entry, never by this process.
    ORG_DB_APP_USERNAME: z.string().min(1),
    ORG_DB_APP_PASSWORD: z.string().min(1),

    ORG_REDIS_HOST: z.string().min(1),
    ORG_REDIS_PORT: z.string().optional(),
    ORG_REDIS_USER: z.string().optional(),
    ORG_REDIS_PASS: z.string().optional(),

    ORG_AMQP_URL: z.string().min(1),
    ORG_AMQP_EXCHANGE_NAME: z.string().min(1),
    ORG_AMQP_QUEUE: z.string().min(1),

    ORG_SESSION_IDLE_TTL_SECONDS: seconds,
    ORG_SESSION_ABSOLUTE_TTL_SECONDS: seconds,
    ORG_STRONG_AUTH_WINDOW_SECONDS: seconds,

    ORG_ENCRYPTION_KEYS: encryptionKeys,
    // HMAC key for email lookup hashes (amendment A14)
    ORG_EMAIL_HASH_KEY: keyBytes,

    ORG_OIDC_ISSUER: httpsUrl,
    ORG_OIDC_CLIENT_ID: z.string().min(1),
    ORG_OIDC_CLIENT_SECRET: z.string().min(1),
    ORG_OIDC_REDIRECT_URI: httpsUrl,
    ORG_OIDC_POST_LOGIN_REDIRECT: url,

    ORG_MAIL_API_KEY: z.string().min(1),
    ORG_MAIL_FROM: z.string().min(1),
    ORG_MAIL_BASE_URL: url,

    // Read by the reused balances/prices code (balances.providers.safe.prices.apiKey)
    ORG_PRICES_PROVIDER_API_KEY: z.string().min(1),
    // Read by BlocklistService (sanctions screening) in reused Safe code
    BLOCKLIST_ENCRYPTED_DATA: z.string().min(1),
    BLOCKLIST_SECRET_KEY: z.string().min(1),
    BLOCKLIST_SECRET_SALT: z.string().min(1),
  })
  .loose();
