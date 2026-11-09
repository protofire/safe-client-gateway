const int = (value: string | undefined, fallback: number): number =>
  value === undefined || value === '' ? fallback : parseInt(value);

/**
 * Configuration of cgw-org. Every key is read from an ORG_* variable (or a
 * shared compliance variable), never from the gateway's secrets. The `redis`,
 * `circuitBreaker`, `httpClient`, `log` ... keys below exist because reused
 * gateway modules call getOrThrow on exactly these names.
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export default () => ({
  about: {
    name: 'cgw-org',
    version: process.env.APPLICATION_VERSION || 'unknown',
    buildNumber: process.env.APPLICATION_BUILD_NUMBER,
  },
  org: {
    application: { port: int(process.env.ORG_APPLICATION_PORT, 3001) },
    // Kept as a string: configureOrgApp rejects anything but a non-negative integer
    trustProxyHops: process.env.ORG_TRUST_PROXY_HOPS ?? '1',
    publicAppUrl: process.env.ORG_PUBLIC_APP_URL,
    db: {
      host: process.env.ORG_DB_HOST,
      port: int(process.env.ORG_DB_PORT, 5432),
      database: process.env.ORG_DB_NAME,
      ssl: process.env.ORG_DB_SSL?.toLowerCase() === 'true',
      app: {
        username: process.env.ORG_DB_APP_USERNAME,
        password: process.env.ORG_DB_APP_PASSWORD,
      },
    },
    amqp: {
      url: process.env.ORG_AMQP_URL,
      exchange: process.env.ORG_AMQP_EXCHANGE_NAME,
      queue: process.env.ORG_AMQP_QUEUE,
    },
    session: {
      idleTtlSeconds: int(process.env.ORG_SESSION_IDLE_TTL_SECONDS, 12 * 3600),
      absoluteTtlSeconds: int(
        process.env.ORG_SESSION_ABSOLUTE_TTL_SECONDS,
        7 * 24 * 3600,
      ),
      strongAuthWindowSeconds: int(
        process.env.ORG_STRONG_AUTH_WINDOW_SECONDS,
        30 * 60,
      ),
    },
    encryption: { keys: process.env.ORG_ENCRYPTION_KEYS },
    emailHashKey: process.env.ORG_EMAIL_HASH_KEY,
    oidc: {
      issuer: process.env.ORG_OIDC_ISSUER,
      clientId: process.env.ORG_OIDC_CLIENT_ID,
      clientSecret: process.env.ORG_OIDC_CLIENT_SECRET,
      redirectUri: process.env.ORG_OIDC_REDIRECT_URI,
      postLoginRedirect: process.env.ORG_OIDC_POST_LOGIN_REDIRECT,
    },
    mail: {
      apiKey: process.env.ORG_MAIL_API_KEY,
      from: process.env.ORG_MAIL_FROM,
      baseUrl: process.env.ORG_MAIL_BASE_URL,
    },
  },
  // ---- keys read by reused gateway modules ----
  application: { isDevelopment: process.env.NODE_ENV !== 'production' },
  auth: { nonceTtlSeconds: int(process.env.AUTH_NONCE_TTL_SECONDS, 5 * 60) },
  balances: {
    providers: {
      safe: {
        prices: { apiKey: process.env.ORG_PRICES_PROVIDER_API_KEY },
      },
    },
  },
  blockchain: {
    blocklistEnabled: process.env.BLOCKLIST_ENABLED?.toLowerCase() !== 'false',
    blocklistSecretData: process.env.BLOCKLIST_ENCRYPTED_DATA,
    blocklistSecretKey: process.env.BLOCKLIST_SECRET_KEY,
    blocklistSecretSalt: process.env.BLOCKLIST_SECRET_SALT,
  },
  circuitBreaker: {
    failureThreshold: int(process.env.CIRCUIT_BREAKER_FAILURE_THRESHOLD, 20),
    successThreshold: int(process.env.CIRCUIT_BREAKER_SUCCESS_THRESHOLD, 10),
    timeout: int(process.env.CIRCUIT_BREAKER_TIMEOUT, 30_000),
    rollingWindow: int(process.env.CIRCUIT_BREAKER_ROLLING_WINDOW, 60_000),
    halfOpenMaxRequests: int(
      process.env.CIRCUIT_BREAKER_HALF_OPEN_MAX_REQUESTS,
      10,
    ),
  },
  expirationTimeInSeconds: {
    deviatePercent: int(process.env.EXPIRATION_DEVIATE_PERCENT, 10),
    default: int(process.env.EXPIRATION_TIME_DEFAULT_SECONDS, 60),
  },
  express: { jsonLimit: process.env.EXPRESS_JSON_LIMIT ?? '1mb' },
  features: {
    cacheInFlightRequests:
      process.env.HTTP_CLIENT_CACHE_IN_FLIGHT_REQUESTS?.toLowerCase() ===
      'true',
    debugLogs: process.env.FF_DEBUG_LOGS?.toLowerCase() === 'true',
  },
  httpClient: {
    requestTimeout: int(
      process.env.HTTP_CLIENT_REQUEST_TIMEOUT_MILLISECONDS,
      5_000,
    ),
  },
  log: {
    level: process.env.LOG_LEVEL || 'info',
    silent: process.env.LOG_SILENT?.toLowerCase() === 'true',
    prettyColorize: process.env.LOG_PRETTY_COLORIZE?.toLowerCase() === 'true',
  },
  // ORG_REDIS_* mapped onto the names CacheModule reads
  redis: {
    user: process.env.ORG_REDIS_USER,
    pass: process.env.ORG_REDIS_PASS,
    host: process.env.ORG_REDIS_HOST || 'localhost',
    port: process.env.ORG_REDIS_PORT || '6379',
    disableOfflineQueue:
      process.env.REDIS_DISABLE_OFFLINE_QUEUE?.toLowerCase() === 'true',
    connectTimeout: int(process.env.REDIS_CONNECT_TIMEOUT, 10_000),
    keepAlive: int(process.env.REDIS_KEEP_ALIVE, 30_000),
  },
});
