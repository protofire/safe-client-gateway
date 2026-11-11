const int = (value: string | undefined, fallback: number): number =>
  value === undefined || value === '' ? fallback : parseInt(value);

const flag = (name: string): boolean =>
  process.env[name]?.toLowerCase() === 'true';

/**
 * Secrets read by reused gateway code, besides the ORG_* ones (allowlist):
 * TX_SERVICE_API_KEY, ETHERSCAN_API_KEY, ORG_PRICES_PROVIDER_API_KEY,
 * ORG_INFURA_API_KEY and the BLOCKLIST_* values. Nothing else, in particular not ZERION_API_KEY.
 *
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
      // opt-in; the schema refuses it in production, the guard here is defence in depth
      logLinks:
        flag('ORG_MAIL_LOG_LINKS') &&
        process.env.NODE_ENV !== 'production' &&
        process.env.CGW_ENV !== 'production',
    },
  },
  // ---- keys read by reused gateway modules ----
  application: {
    isDevelopment: process.env.NODE_ENV !== 'production',
    isProduction: process.env.CGW_ENV === 'production',
  },
  contracts: {
    trustedForDelegateCall: {
      maxSequentialPages: int(
        process.env.TRUSTED_CONTRACTS_MAX_SEQUENTIAL_PAGES,
        3,
      ),
    },
  },
  etherscan: {
    baseUri:
      process.env.ETHERSCAN_BASE_URI || 'https://api.etherscan.io/v2/api',
    apiKey: process.env.ETHERSCAN_API_KEY,
    gasPriceCacheTtlSeconds: int(
      process.env.ETHERSCAN_GAS_PRICE_CACHE_TTL_SECONDS,
      10,
    ),
  },
  owners: { ownersTtlSeconds: int(process.env.OWNERS_TTL_SECONDS, 0) },
  safeDataDecoder: {
    baseUri:
      process.env.SAFE_DATA_DECODER_BASE_URI ||
      'https://safe-decoder.safe.global',
  },
  safeConfig: {
    baseUri:
      process.env.SAFE_CONFIG_BASE_URI || 'https://safe-config.safe.global/',
    chains: {
      maxSequentialPages: int(
        process.env.SAFE_CONFIG_CHAINS_MAX_SEQUENTIAL_PAGES,
        3,
      ),
    },
    safes: {
      maxSequentialPages: int(
        process.env.SAFE_CONFIG_SAFES_MAX_SEQUENTIAL_PAGES,
        10,
      ),
    },
  },
  safeTransaction: {
    useVpcUrl: process.env.USE_TX_SERVICE_VPC_URL?.toLowerCase() === 'true',
    apiKey: process.env.TX_SERVICE_API_KEY,
  },
  auth: { nonceTtlSeconds: int(process.env.AUTH_NONCE_TTL_SECONDS, 5 * 60) },
  balances: {
    providers: {
      safe: {
        prices: {
          baseUri:
            process.env.PRICES_PROVIDER_API_BASE_URI ||
            'https://api.coingecko.com/api/v3',
          apiKey: process.env.ORG_PRICES_PROVIDER_API_KEY,
          pricesTtlSeconds: int(process.env.PRICES_TTL_SECONDS, 300),
          nativeCoinPricesTtlSeconds: int(
            process.env.NATIVE_COINS_PRICES_TTL_SECONDS,
            100,
          ),
          notFoundPriceTtlSeconds: int(
            process.env.NOT_FOUND_PRICE_TTL_SECONDS,
            72 * 60 * 60,
          ),
          highRefreshRateTokens:
            process.env.HIGH_REFRESH_RATE_TOKENS?.split(',') ?? [],
          highRefreshRateTokensTtlSeconds: int(
            process.env.HIGH_REFRESH_RATE_TOKENS_TTL_SECONDS,
            30,
          ),
        },
      },
      // Zerion stays off (features.zerionBalancesEnabled); the keys exist because the reused module reads them
      zerion: {
        apiKey: undefined, // Zerion is disabled: its key is never read
        baseUri: process.env.ZERION_BASE_URI || 'https://api.zerion.io',
        currencies: [
          'USD',
          'EUR',
          'ETH',
          'AUD',
          'BTC',
          'CAD',
          'CHF',
          'CNY',
          'GBP',
          'INR',
          'JPY',
          'KRW',
          'NZD',
          'RUB',
          'TRY',
          'ZAR',
        ],
        limitPeriodSeconds: int(
          process.env.ZERION_RATE_LIMIT_PERIOD_SECONDS,
          10,
        ),
        limitCalls: int(process.env.ZERION_RATE_LIMIT_CALLS_BY_PERIOD, 2),
      },
    },
  },
  blockchain: {
    blocklistEnabled: process.env.BLOCKLIST_ENABLED?.toLowerCase() !== 'false',
    blocklistSecretData: process.env.BLOCKLIST_ENCRYPTED_DATA,
    blocklistSecretKey: process.env.BLOCKLIST_SECRET_KEY,
    blocklistSecretSalt: process.env.BLOCKLIST_SECRET_SALT,
    // only appended to Infura RPC URIs of the chain config (payout run simulation)
    infura: { apiKey: process.env.ORG_INFURA_API_KEY ?? '' },
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
    rpc: int(process.env.EXPIRATION_TIME_RPC_SECONDS, 15),
    hoodi: int(process.env.HOODI_EXPIRATION_TIME_SECONDS, 60),
    indexing: int(process.env.EXPIRATION_TIME_INDEXING_SECONDS, 5),
    notFound: {
      default: int(process.env.DEFAULT_NOT_FOUND_EXPIRE_TIME_SECONDS, 30),
      contract: int(process.env.CONTRACT_NOT_FOUND_EXPIRE_TIME_SECONDS, 60),
      token: int(process.env.TOKEN_NOT_FOUND_EXPIRE_TIME_SECONDS, 60),
    },
  },
  express: { jsonLimit: process.env.EXPRESS_JSON_LIMIT ?? '1mb' },
  features: {
    cacheInFlightRequests:
      process.env.HTTP_CLIENT_CACHE_IN_FLIGHT_REQUESTS?.toLowerCase() ===
      'true',
    debugLogs: process.env.FF_DEBUG_LOGS?.toLowerCase() === 'true',
    configHooksDebugLogs:
      process.env.FF_CONFIG_HOOKS_DEBUG_LOGS?.toLowerCase() === 'true',
    // Zerion and counterfactual balances are out of scope for the org process
    zerionBalancesEnabled: false,
    counterfactualBalances: false,
    // Read by the reused TransactionVerifierHelper; same names as the gateway, off by default
    hashVerification: {
      api: flag('FF_HASH_VERIFICATION_API'),
      proposal: flag('FF_HASH_VERIFICATION_PROPOSAL'),
    },
    signatureVerification: {
      api: flag('FF_SIGNATURE_VERIFICATION_API'),
      proposal: flag('FF_SIGNATURE_VERIFICATION_PROPOSAL'),
    },
    ethSign: flag('FF_ETH_SIGN'),
    trustedDelegateCall: flag('FF_TRUSTED_DELEGATE_CALL'),
    trustedForDelegateCallContractsList: flag(
      'FF_TRUSTED_FOR_DELEGATE_CALL_CONTRACTS_LIST',
    ),
  },
  httpClient: {
    requestTimeout: int(
      process.env.HTTP_CLIENT_REQUEST_TIMEOUT_MILLISECONDS,
      5_000,
    ),
    ownersTimeout: int(
      process.env.HTTP_CLIENT_REQUEST_TIMEOUT_MILLISECONDS_OWNERS,
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
