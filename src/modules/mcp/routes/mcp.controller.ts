import {
  All,
  Controller,
  type OnModuleDestroy,
  Req,
  Res,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import type { Request, Response } from 'express';
import { McpServerFactory } from '@/modules/mcp/mcp-server.factory';

@Controller()
@ApiExcludeController()
export class McpController implements OnModuleDestroy {
  private readonly handler: ReturnType<typeof createMcpHandler>;
  private readonly node: ReturnType<typeof toNodeHandler>;

  constructor(factory: McpServerFactory) {
    this.handler = createMcpHandler(() => factory.create());
    this.node = toNodeHandler(this.handler);
  }

  @All('mcp')
  handle(@Req() req: Request, @Res() res: Response): Promise<void> {
    return this.node(req, res, req.body);
  }

  onModuleDestroy(): Promise<void> {
    return this.handler.close();
  }
}
