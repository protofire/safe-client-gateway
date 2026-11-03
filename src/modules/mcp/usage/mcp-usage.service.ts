import { createHash } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { LogType } from '@/domain/common/entities/log-type.entity';
import { ILoggingService, LoggingService } from '@/logging/logging.interface';
import { MCP_IP_KEY } from '@/modules/mcp/routes/guards/mcp-rate-limit.guard';
import {
  McpToolEvents,
  type McpToolCall,
} from '@/modules/mcp/tools/define-tool';
import { clientLabel } from '@/modules/mcp/usage/client-label';
import { withTimeout } from '@/modules/mcp/with-timeout';
import {
  McpUsageStore,
  type IMcpUsageStore,
} from '@/modules/mcp/usage/mcp-usage.store';

export const MCP_USER_AGENT_KEY = 'mcp.userAgent';
export const MCP_PROTOCOL_VERSION_KEY = 'mcp.protocolVersion';
export const MAX_USER_AGENT_LENGTH = 200;
const WRITE_TIMEOUT_MS = 2000;
const CANONICAL_CHAIN_ID = /^[1-9]\d*$/;

function chainOf(chainId: string | null): string {
  if (chainId === null) {
    return 'none';
  }
  return CANONICAL_CHAIN_ID.test(chainId) ? chainId : 'unknown';
}

/**
 * Counts tool calls by tool, chain, client label and outcome, and distinct
 * clients by a daily-salted hash. The raw IP and User-Agent are only ever
 * hashed; writes never delay or fail a tool result.
 */
@Injectable()
export class McpUsageService {
  constructor(
    events: McpToolEvents,
    @Inject(McpUsageStore) private readonly store: IMcpUsageStore,
    @Inject(LoggingService) private readonly loggingService: ILoggingService,
    private readonly cls: ClsService,
  ) {
    events.onCall = (call): void => this.record(call);
  }

  private record(call: McpToolCall): void {
    const label = clientLabel({
      clientName: call.clientName,
      userAgent: this.cls.get<string | undefined>(MCP_USER_AGENT_KEY),
    });
    const ip = this.cls.get<string | undefined>(MCP_IP_KEY);
    const userAgent = this.cls.get<string | undefined>(MCP_USER_AGENT_KEY);
    // `ok` does not prove the chain resolved ("01" is chain 1), and the id is
    // client input: only canonical ids may become part of a field
    const chainId = call.outcome === 'ok' ? chainOf(call.chainId) : 'unknown';

    this.loggingService.info({
      type: LogType.McpToolCall,
      tool: call.tool,
      chainId,
      outcome: call.outcome,
      latencyMs: Math.round(call.latencyMs),
      resultCount: call.resultCount,
      protocolVersion: this.cls.get<string | undefined>(
        MCP_PROTOCOL_VERSION_KEY,
      ),
      clientLabel: label,
    });

    const date = new Date().toISOString().slice(0, 10);
    const field = [call.tool, chainId, label, call.outcome].join('|');
    const countsClient = call.useful && call.outcome === 'ok';
    // Fire and forget: Redis may be down and hang commands
    void withTimeout(
      this.write(date, field, countsClient, ip, userAgent),
      WRITE_TIMEOUT_MS,
      'usage write timed out',
    ).catch((error: unknown) =>
      this.loggingService.warn({
        message: 'MCP usage write failed',
        error: error instanceof Error ? error.message : typeof error,
      }),
    );
  }

  private async write(
    date: string,
    field: string,
    useful: boolean,
    ip: string | undefined,
    userAgent: string | undefined,
  ): Promise<void> {
    await this.store.incrementCall(date, field);
    if (!useful || !ip) {
      return;
    }
    const salt = await this.store.getDailySalt(date);
    const hash = createHash('sha256')
      .update(`${ip}|${userAgent ?? ''}|${salt}`)
      .digest('hex');
    await this.store.addClient(date, hash);
  }
}
