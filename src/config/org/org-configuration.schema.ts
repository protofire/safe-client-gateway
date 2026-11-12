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

const ADDRESS = /^0x[0-9a-f]{40}$/;
const isEmail = (v: string): boolean => z.email().safeParse(v).success;

const allowlistEntries = (raw: string | undefined): Array<string> =>
  (raw ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

/** ORG_CREATE_ALLOWLIST: comma-separated wallets and emails, trimmed and lowercased; unset = empty. */
export function parseCreateAllowlist(raw: string | undefined): {
  wallets: Array<string>;
  emails: Array<string>;
} {
  const entries = allowlistEntries(raw);
  return {
    wallets: entries.filter((e) => e.startsWith('0x')),
    emails: entries.filter((e) => !e.startsWith('0x')),
  };
}

// reports positions, not values: entries are emails
const createAllowlist = z.string().superRefine((value, ctx) => {
  const invalid = allowlistEntries(value)
    .map((e, i) => (ADDRESS.test(e) || isEmail(e) ? 0 : i + 1))
    .filter(Boolean);
  if (invalid.length > 0) {
    ctx.addIssue({
      code: 'custom',
      message: `Each entry must be a 0x wallet address or an email; invalid entry number(s): ${invalid.join(', ')}`,
    });
  }
});

/** True for a parseable URL on localhost, 127.0.0.1 or [::1]. */
export function isLoopbackUrl(value: string | undefined): boolean {
  return (
    value !== undefined &&
    URL.canParse(value) &&
    ['localhost', '127.0.0.1', '[::1]'].includes(new URL(value).hostname)
  );
}

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

    // Beta gate on POST /v1/orgs; unset or empty = anyone signed in may create
    ORG_CREATE_ALLOWLIST: createAllowlist.optional(),

    // Global breaker for email sign-in codes per hour (default 200)
    ORG_EMAIL_OTP_MAX_SENDS_PER_HOUR: z.coerce.number().int().min(1).optional(),

    // Google: https://accounts.google.com (endpoints from its discovery document)
    ORG_OIDC_ISSUER: httpsUrl,
    ORG_OIDC_CLIENT_ID: z.string().min(1),
    ORG_OIDC_CLIENT_SECRET: z.string().min(1),
    ORG_OIDC_REDIRECT_URI: httpsUrl,
    ORG_OIDC_POST_LOGIN_REDIRECT: url,

    // Optional outside production: without it the invite link is logged instead of mailed
    ORG_MAIL_API_KEY: z.string().min(1).optional(),
    // Opt-in: log the invite link (carries the token) and email sign-in codes when no API key is set; refused in production
    ORG_MAIL_LOG_LINKS: z.enum(['true', 'false']).optional(),
    ORG_MAIL_FROM: z.string().min(1),
    ORG_MAIL_BASE_URL: url,

    // Read by the reused balances/prices code (balances.providers.safe.prices.apiKey)
    ORG_PRICES_PROVIDER_API_KEY: z.string().min(1),
    // Read by BlocklistService (sanctions screening) in reused Safe code
    BLOCKLIST_ENCRYPTED_DATA: z.string().min(1),
    BLOCKLIST_SECRET_KEY: z.string().min(1),
    BLOCKLIST_SECRET_SALT: z.string().min(1),
  })
  .loose()
  .superRefine((env, ctx) => {
    const production =
      env.NODE_ENV === 'production' || env.CGW_ENV === 'production';
    if (production && !env.ORG_MAIL_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['ORG_MAIL_API_KEY'],
        message: 'Required in production',
      });
    }
    // codes and invite tokens in logs only for a local app on a loopback host
    if (
      env.ORG_MAIL_LOG_LINKS === 'true' &&
      !isLoopbackUrl(env.ORG_PUBLIC_APP_URL)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['ORG_MAIL_LOG_LINKS'],
        message:
          'Only for local dev: ORG_PUBLIC_APP_URL must be on localhost, 127.0.0.1 or [::1]',
      });
    }
    if (production && env.ORG_MAIL_LOG_LINKS === 'true') {
      ctx.addIssue({
        code: 'custom',
        path: ['ORG_MAIL_LOG_LINKS'],
        message:
          'Must not be true in production (logs invitation tokens and sign-in codes)',
      });
    }
  })
  .refine(
    // Sharing the gateway's queue would split its events between two consumers
    (env) =>
      !process.env.AMQP_QUEUE || env.ORG_AMQP_QUEUE !== process.env.AMQP_QUEUE,
    {
      path: ['ORG_AMQP_QUEUE'],
      error: 'Must differ from the gateway AMQP_QUEUE',
    },
  );
