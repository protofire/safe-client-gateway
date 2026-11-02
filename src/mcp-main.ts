import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { configureShutdownHooks } from '@/app.provider';
import { IConfigurationService } from '@/config/configuration.service.interface';
import { McpAppModule } from '@/mcp-app.module';

export function configureMcpApp(app: NestExpressApplication): void {
  const hops = process.env.MCP_TRUST_PROXY_HOPS ?? '1';
  // NaN would disable proxy trust: every caller would share one rate-limit bucket
  if (!/^\d+$/.test(hops)) {
    throw new Error(
      `MCP_TRUST_PROXY_HOPS must be a non-negative integer, got "${hops}"`,
    );
  }

  configureShutdownHooks(app);
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
