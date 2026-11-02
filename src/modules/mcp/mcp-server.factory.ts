import { Inject, Injectable } from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/server';
import { IConfigurationService } from '@/config/configuration.service.interface';
import { IChainsRepository } from '@/modules/chains/domain/chains.repository.interface';
import { chainsTools } from '@/modules/mcp/tools/chains.tools';
import { McpToolEvents, type McpTool } from '@/modules/mcp/tools/define-tool';
import { safeTools } from '@/modules/mcp/tools/safe.tools';
import { ISafeRepository } from '@/modules/safe/domain/safe.repository.interface';

@Injectable()
export class McpServerFactory {
  private readonly serverName: string;
  private readonly version: string;
  private readonly tools: Array<McpTool>;

  constructor(
    @Inject(IConfigurationService) configurationService: IConfigurationService,
    @Inject(IChainsRepository) chainsRepository: IChainsRepository,
    @Inject(ISafeRepository) safeRepository: ISafeRepository,
    private readonly events: McpToolEvents,
  ) {
    this.serverName = configurationService.getOrThrow('mcp.serverName');
    this.version = configurationService.getOrThrow('about.version');
    // tools/list keeps this order
    this.tools = [
      ...chainsTools(chainsRepository),
      ...safeTools(safeRepository),
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
        (args: unknown) => tool.call(args, this.events),
      );
    }
    return server;
  }
}
