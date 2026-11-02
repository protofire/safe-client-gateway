import { Module } from '@nestjs/common';
import { BalancesModule } from '@/modules/balances/balances.module';
import { ChainsModule } from '@/modules/chains/chains.module';
import { DataDecoderModule } from '@/modules/data-decoder/data-decoder.module';
import { DelegatesV2RepositoryModule } from '@/modules/delegate/domain/v2/delegates.v2.repository.interface';
import { McpFanoutLimit } from '@/modules/mcp/mcp-fanout-limit';
import { McpServerFactory } from '@/modules/mcp/mcp-server.factory';
import { McpRateLimitGuard } from '@/modules/mcp/routes/guards/mcp-rate-limit.guard';
import { McpController } from '@/modules/mcp/routes/mcp.controller';
import { McpToolEvents } from '@/modules/mcp/tools/define-tool';
import { SafeRepositoryModule } from '@/modules/safe/domain/safe.repository.interface';
import { TransactionsModule } from '@/modules/transactions/transactions.module';

@Module({
  imports: [
    BalancesModule,
    ChainsModule,
    DataDecoderModule,
    DelegatesV2RepositoryModule,
    SafeRepositoryModule,
    TransactionsModule,
  ],
  controllers: [McpController],
  providers: [
    McpServerFactory,
    McpToolEvents,
    McpFanoutLimit,
    McpRateLimitGuard,
  ],
})
export class McpModule {}
