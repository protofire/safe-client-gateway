import {
  All,
  Controller,
  type OnModuleDestroy,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { toNodeHandler } from '@modelcontextprotocol/node';
import {
  createMcpHandler,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '@modelcontextprotocol/server';
import type { Request, Response } from 'express';
import { ClsService } from 'nestjs-cls';
import { McpRateLimitGuard } from '@/modules/mcp/routes/guards/mcp-rate-limit.guard';
import { McpServerFactory } from '@/modules/mcp/mcp-server.factory';
import {
  MAX_USER_AGENT_LENGTH,
  MCP_PROTOCOL_VERSION_KEY,
  MCP_USER_AGENT_KEY,
} from '@/modules/mcp/usage/mcp-usage.service';

@Controller()
@ApiExcludeController()
export class McpController implements OnModuleDestroy {
  private readonly handler: ReturnType<typeof createMcpHandler>;
  private readonly node: ReturnType<typeof toNodeHandler>;

  constructor(
    factory: McpServerFactory,
    private readonly cls: ClsService,
  ) {
    this.handler = createMcpHandler(() => factory.create());
    this.node = toNodeHandler(this.handler);
  }

  @UseGuards(McpRateLimitGuard)
  @All('mcp')
  handle(@Req() req: Request, @Res() res: Response): Promise<void> {
    // MCP dropped batching in 2025-06-18; a batch would also run many calls for one rate-limit charge
    if (Array.isArray(req.body)) {
      res.status(400).json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'Batch requests are not supported' },
      });
      return Promise.resolve();
    }
    this.cls.set(
      MCP_USER_AGENT_KEY,
      req.get('user-agent')?.slice(0, MAX_USER_AGENT_LENGTH),
    );
    const version = req.get('mcp-protocol-version');
    this.cls.set(
      MCP_PROTOCOL_VERSION_KEY,
      // A closed set keeps the logged value bounded
      SUPPORTED_PROTOCOL_VERSIONS.includes(version ?? '') ? version : undefined,
    );
    return this.node(req, res, req.body);
  }

  onModuleDestroy(): Promise<void> {
    return this.handler.close();
  }
}
