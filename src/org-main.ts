import type { NextFunction, Request, Response } from 'express';
import { VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { json } from 'express';
import { configureShutdownHooks } from '@/app.provider';
import { IConfigurationService } from '@/config/configuration.service.interface';
import { OrgAppModule } from '@/org-app.module';

const EXACT_PATHS = new Set(['/v1/orgs', '/health/live', '/health/ready']);
const ORGS_PREFIX = '/v1/orgs/';

// Reused modules mount gateway routes; the org process must expose none of them
function allowOnlyOrgPaths(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (EXACT_PATHS.has(req.path) || req.path.startsWith(ORGS_PREFIX)) {
    next();
    return;
  }
  res.status(404).json({ statusCode: 404, message: 'Not Found' });
}

export function configureOrgApp(app: NestExpressApplication): void {
  const config = app.get<IConfigurationService>(IConfigurationService);
  const hops = String(config.getOrThrow<string | number>('org.trustProxyHops'));
  // NaN would disable proxy trust: every caller would share one rate-limit bucket
  if (!/^\d+$/.test(hops)) {
    throw new Error(
      `ORG_TRUST_PROXY_HOPS must be a non-negative integer, got "${hops}"`,
    );
  }

  configureShutdownHooks(app);
  app.use(allowOnlyOrgPaths);
  // A hop count, never `true`: the left-most X-Forwarded-For is client-controlled
  app.set('trust proxy', Number(hops));
  app.enableVersioning({ type: VersioningType.URI });
  app.enableCors({
    origin: config.getOrThrow<string>('org.publicAppUrl'),
    credentials: true,
    allowedHeaders: ['Content-Type', 'X-Org-Request'],
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  });
  app.use(json({ limit: config.getOrThrow<string>('express.jsonLimit') }));
  app.use(cookieParser());
}

export async function bootstrapOrg(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(
    OrgAppModule.register(),
  );
  configureOrgApp(app);

  const config = app.get<IConfigurationService>(IConfigurationService);
  await app.listen(config.getOrThrow('org.application.port'));
}

if (require.main === module) {
  void bootstrapOrg();
}
