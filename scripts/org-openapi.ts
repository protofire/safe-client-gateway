/**
 * `yarn org:openapi`: writes org-openapi.json (the cgw-org API for the UI)
 * from OrgAppModule. Boots without Redis, Postgres or AMQP: those providers
 * are replaced and the app is never initialised or listening. Placeholder
 * config only; no runtime docs route exists in cgw-org.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { getDataSourceToken } from '@nestjs/typeorm';
import { format, resolveConfig } from 'prettier';
import { ORG_REDIS } from '@/modules/org/auth/nonce.store';
import { ORG_DATA_SOURCE } from '@/modules/org/db/org-database.module';
import { OrgAppModule } from '@/org-app.module';
import { configureOrgApp } from '@/org-main';

const KEY = Buffer.alloc(32).toString('base64');
const PLACEHOLDER_ENV: Record<string, string> = {
  ORG_TRUST_PROXY_HOPS: '1',
  ORG_PUBLIC_APP_URL: 'https://app.example.com',
  ORG_DB_HOST: 'localhost',
  ORG_DB_PORT: '5432',
  ORG_DB_NAME: 'org',
  ORG_DB_APP_USERNAME: 'org_app',
  ORG_DB_APP_PASSWORD: 'placeholder',
  ORG_REDIS_HOST: 'localhost',
  ORG_AMQP_URL: 'amqp://localhost',
  ORG_AMQP_EXCHANGE_NAME: 'placeholder',
  ORG_AMQP_QUEUE: 'org-openapi',
  ORG_ENCRYPTION_KEYS: JSON.stringify({ current: 'v1', keys: { v1: KEY } }),
  ORG_EMAIL_HASH_KEY: KEY,
  ORG_OIDC_ISSUER: 'https://idp.example.com/',
  ORG_OIDC_CLIENT_ID: 'placeholder',
  ORG_OIDC_CLIENT_SECRET: 'placeholder',
  ORG_OIDC_REDIRECT_URI: 'https://api.example.com/v1/orgs/auth/oidc/callback',
  ORG_OIDC_POST_LOGIN_REDIRECT: 'https://app.example.com/',
  ORG_MAIL_FROM: 'noreply@example.com',
  ORG_MAIL_BASE_URL: 'https://mail.example.com',
  ORG_PRICES_PROVIDER_API_KEY: 'placeholder',
  BLOCKLIST_ENCRYPTED_DATA: 'placeholder',
  BLOCKLIST_SECRET_KEY: 'placeholder',
  BLOCKLIST_SECRET_SALT: 'placeholder',
};

/** Same allowlist as org-main's allowOnlyOrgPaths: reused modules mount gateway routes. */
function isOrgPath(path: string): boolean {
  return (
    path === '/v1/orgs' ||
    path.startsWith('/v1/orgs/') ||
    path === '/health/live' ||
    path === '/health/ready'
  );
}

async function main(): Promise<void> {
  // never the real environment: the document must not depend on it
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ORG_') || key.startsWith('BLOCKLIST_')) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, PLACEHOLDER_ENV);

  const noop = async (): Promise<void> => {};
  const moduleRef = await Test.createTestingModule({
    imports: [OrgAppModule.register()],
  })
    .overrideProvider('RedisClient')
    .useValue({ ping: noop, isReady: true, quit: noop })
    .overrideProvider(ORG_REDIS)
    .useValue({ quit: noop })
    .overrideProvider(getDataSourceToken(ORG_DATA_SOURCE))
    .useValue({ manager: {}, isInitialized: true, destroy: noop })
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    logger: false,
  });
  configureOrgApp(app);

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('cgw-org')
      .setDescription(
        'Organization API. Cookie session `org_session`; non-GET requests need `X-Org-Request: 1`. SIWE accepts EOA signatures only in phase 1.',
      )
      .build(),
  );
  document.paths = Object.fromEntries(
    Object.entries(document.paths)
      .filter(([path]) => isOrgPath(path))
      .sort(([a], [b]) => a.localeCompare(b)),
  );

  const out = join(__dirname, '..', 'org-openapi.json');
  // formatted like the rest of the repo, so `yarn format-check` passes
  writeFileSync(
    out,
    await format(JSON.stringify(document), {
      ...(await resolveConfig(out)),
      filepath: out,
    }),
  );
  const operations = Object.values(document.paths).reduce(
    (n, item) => n + Object.keys(item).length,
    0,
  );
  console.log(
    `${out}: ${Object.keys(document.paths).length} paths, ${operations} operations`,
  );
  await moduleRef.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
