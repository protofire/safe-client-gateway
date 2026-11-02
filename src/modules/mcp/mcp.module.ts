import { Module } from '@nestjs/common';
import { ChainsModule } from '@/modules/chains/chains.module';
import { McpServerFactory } from '@/modules/mcp/mcp-server.factory';
import { McpController } from '@/modules/mcp/routes/mcp.controller';
import { McpToolEvents } from '@/modules/mcp/tools/define-tool';
import { SafeRepositoryModule } from '@/modules/safe/domain/safe.repository.interface';

@Module({
  imports: [ChainsModule, SafeRepositoryModule],
  controllers: [McpController],
  providers: [McpServerFactory, McpToolEvents],
})
export class McpModule {}
