import { Inject, Injectable } from '@nestjs/common';
import {
  CLIENT_INFO_META_KEY,
  McpServer,
  PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';
import { IConfigurationService } from '@/config/configuration.service.interface';
import { IChainsRepository } from '@/modules/chains/domain/chains.repository.interface';
import { BalancesService } from '@/modules/balances/routes/balances.service';
import { McpFanoutLimit } from '@/modules/mcp/mcp-fanout-limit';
import { balancesTools } from '@/modules/mcp/tools/balances.tools';
import { chainsTools } from '@/modules/mcp/tools/chains.tools';
import { McpToolEvents, type McpTool } from '@/modules/mcp/tools/define-tool';
import { ownersTools } from '@/modules/mcp/tools/owners.tools';
import { proposersTools } from '@/modules/mcp/tools/proposers.tools';
import { safeTools } from '@/modules/mcp/tools/safe.tools';
import { transactionsTools } from '@/modules/mcp/tools/transactions.tools';
import { IDataDecoderRepository } from '@/modules/data-decoder/domain/v2/data-decoder.repository.interface';
import { IDelegatesV2Repository } from '@/modules/delegate/domain/v2/delegates.v2.repository.interface';
import { ISafeRepository } from '@/modules/safe/domain/safe.repository.interface';
import { TransactionsService } from '@/modules/transactions/routes/transactions.service';

@Injectable()
export class McpServerFactory {
  private readonly serverName: string;
  private readonly version: string;
  private readonly tools: Array<McpTool>;

  constructor(
    @Inject(IConfigurationService) configurationService: IConfigurationService,
    @Inject(IChainsRepository) chainsRepository: IChainsRepository,
    @Inject(ISafeRepository) safeRepository: ISafeRepository,
    balancesService: BalancesService,
    transactionsService: TransactionsService,
    @Inject(IDataDecoderRepository)
    dataDecoderRepository: IDataDecoderRepository,
    @Inject(IDelegatesV2Repository)
    delegatesRepository: IDelegatesV2Repository,
    private readonly events: McpToolEvents,
    fanoutLimit: McpFanoutLimit,
  ) {
    this.serverName = configurationService.getOrThrow('mcp.serverName');
    this.version = configurationService.getOrThrow('about.version');
    // tools/list keeps this order
    this.tools = [
      ...chainsTools(chainsRepository),
      ...ownersTools(safeRepository, fanoutLimit),
      ...safeTools(safeRepository),
      ...balancesTools(balancesService),
      ...transactionsTools(transactionsService, dataDecoderRepository),
      ...proposersTools(delegatesRepository),
    ];
  }

  create(): McpServer {
    const server = new McpServer({
      name: `${this.serverName} MCP`,
      version: this.version,
    });
    for (const tool of this.tools) {
      server.registerTool(
        tool.name,
        {
          title: tool.title,
          description: tool.description,
          inputSchema: tool.listedSchema,
          annotations: tool.annotations,
        },
        (args: unknown, ctx) => {
          // 2026-07-28 requests carry the envelope; 2025 ones the initialize
          const envelope = (ctx.mcpReq.envelope ?? {}) as Record<
            string,
            unknown
          >;
          // The accessors are deprecated for 2026 requests only; 2025 has no other source
          /* eslint-disable @typescript-eslint/no-deprecated */
          const clientInfo = (envelope[CLIENT_INFO_META_KEY] ??
            server.server.getClientVersion()) as { name?: string } | undefined;
          return tool.call(args, this.events, {
            clientName: clientInfo?.name,
            protocolVersion: (envelope[PROTOCOL_VERSION_META_KEY] ??
              server.server.getNegotiatedProtocolVersion()) as
              | string
              | undefined,
          });
          /* eslint-enable @typescript-eslint/no-deprecated */
        },
      );
    }
    return server;
  }
}
