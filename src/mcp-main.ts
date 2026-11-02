import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { configureShutdownHooks } from '@/app.provider';
import { IConfigurationService } from '@/config/configuration.service.interface';
import { McpAppModule } from '@/mcp-app.module';

export function configureMcpApp(app: NestExpressApplication): void {
  configureShutdownHooks(app);
  // A hop count, never `true`: the left-most X-Forwarded-For is client-controlled
  app.set('trust proxy', Number(process.env.MCP_TRUST_PROXY_HOPS ?? 1));
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
