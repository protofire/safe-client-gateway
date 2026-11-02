import type { NextFunction, Request, Response } from 'express';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { configureShutdownHooks } from '@/app.provider';
import { IConfigurationService } from '@/config/configuration.service.interface';
import { McpAppModule } from '@/mcp-app.module';

// The imported modules mount REST routes (propose, delete) that /mcp must never expose
const ALLOWED_PATHS = new Set([
  '/mcp',
  '/mcp/usage.json',
  '/health/live',
  '/health/ready',
]);

function allowOnlyMcpPaths(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (ALLOWED_PATHS.has(req.path)) {
    next();
    return;
  }
  res.status(404).json({ statusCode: 404, message: 'Not Found' });
}

export function configureMcpApp(app: NestExpressApplication): void {
  const hops = process.env.MCP_TRUST_PROXY_HOPS ?? '1';
  // NaN would disable proxy trust: every caller would share one rate-limit bucket
  if (!/^\d+$/.test(hops)) {
    throw new Error(
      `MCP_TRUST_PROXY_HOPS must be a non-negative integer, got "${hops}"`,
    );
  }

  configureShutdownHooks(app);
  app.use(allowOnlyMcpPaths);
  // A hop count, never `true`: the left-most X-Forwarded-For is client-controlled
  app.set('trust proxy', Number(hops));
}

export async function bootstrapMcp(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(
    McpAppModule.register(),
  );
  configureMcpApp(app);

  const configurationService = app.get<IConfigurationService>(
    IConfigurationService,
  );
  await app.listen(configurationService.getOrThrow('application.port'));
}

if (require.main === module) {
  void bootstrapMcp();
}
