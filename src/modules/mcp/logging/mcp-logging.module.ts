import { Global, Module } from '@nestjs/common';
import type winston from 'winston';
import { IConfigurationService } from '@/config/configuration.service.interface';
import { LoggingService } from '@/logging/logging.interface';
import {
  winstonFactory,
  winstonTransportsFactory,
} from '@/logging/logging.module';
import { RequestScopedLoggingService } from '@/logging/logging.service';
import { McpLoggingService } from '@/modules/mcp/logging/mcp-logging.service';

/** RequestScopedLoggingModule for cgw-mcp: same output, tool arguments removed. */
@Global()
@Module({
  providers: [
    { provide: LoggingService, useClass: McpLoggingService },
    RequestScopedLoggingService,
    {
      provide: 'Logger',
      useFactory: (
        configurationService: IConfigurationService,
      ): winston.Logger =>
        winstonFactory(
          winstonTransportsFactory(configurationService),
          configurationService,
        ),
      inject: [IConfigurationService],
    },
  ],
  exports: [LoggingService],
})
export class McpLoggingModule {}
