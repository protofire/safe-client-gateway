import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { McpUsageAuthGuard } from '@/modules/mcp/routes/guards/mcp-usage-auth.guard';
import {
  McpUsageStore,
  type IMcpUsageStore,
  type McpUsageDay,
} from '@/modules/mcp/usage/mcp-usage.store';

const WINDOW_DAYS = 30;
const READ_TIMEOUT_MS = 2_000;

type UsageReportDay = {
  date: string;
  calls: Array<{
    tool: string;
    chainId: string;
    client: string;
    outcome: string;
    count: number;
  }>;
  distinctClients: number;
};

/** Outside McpController so McpRateLimitGuard does not apply. */
@Controller()
@ApiExcludeController()
export class McpUsageController {
  constructor(@Inject(McpUsageStore) private readonly store: IMcpUsageStore) {}

  @UseGuards(McpUsageAuthGuard)
  @Get('mcp/usage.json')
  async report(): Promise<{
    generatedAt: string;
    windowDays: number;
    freshness: { lastCallDate: string | null };
    coverage: { daysRead: number; daysFailed: number };
    days: Array<UsageReportDay>;
  }> {
    const now = new Date();
    const dates = Array.from({ length: WINDOW_DAYS }, (_, i) =>
      new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10),
    );
    const results = await Promise.allSettled(
      dates.map((date) => this.readDay(date)),
    );

    const days: Array<UsageReportDay> = [];
    results.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        days.push(this.toReportDay(dates[i], result.value));
      }
    });
    return {
      generatedAt: now.toISOString(),
      windowDays: WINDOW_DAYS,
      // Newest first, so the first day with calls is the latest
      freshness: {
        lastCallDate: days.find((day) => day.calls.length)?.date ?? null,
      },
      coverage: {
        daysRead: days.length,
        daysFailed: WINDOW_DAYS - days.length,
      },
      days,
    };
  }

  private async readDay(date: string): Promise<McpUsageDay> {
    let timeout: NodeJS.Timeout | undefined;
    try {
      // With Redis down the client queues commands offline and they never settle
      return await Promise.race([
        this.store.getDay(date),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error('usage read timed out')),
            READ_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }

  private toReportDay(date: string, day: McpUsageDay): UsageReportDay {
    return {
      date,
      calls: Object.entries(day.calls).map(([field, count]) => {
        const [tool, chainId, client, outcome] = field.split('|');
        return { tool, chainId, client, outcome, count };
      }),
      distinctClients: day.clients,
    };
  }
}
