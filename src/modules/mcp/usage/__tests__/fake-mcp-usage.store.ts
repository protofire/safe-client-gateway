import { Injectable } from '@nestjs/common';
import type {
  IMcpUsageStore,
  McpUsageDay,
} from '@/modules/mcp/usage/mcp-usage.store';

/** Keeps usage in memory; `clients` holds the raw hashes for assertions. */
@Injectable()
export class FakeMcpUsageStore implements IMcpUsageStore {
  readonly calls: Record<string, number> = {};
  readonly clients = new Set<string>();
  readonly salt = 'test-salt';

  incrementCall(_date: string, field: string): Promise<void> {
    this.calls[field] = (this.calls[field] ?? 0) + 1;
    return Promise.resolve();
  }

  addClient(_date: string, hash: string): Promise<void> {
    this.clients.add(hash);
    return Promise.resolve();
  }

  getDay(): Promise<McpUsageDay> {
    return Promise.resolve({
      calls: { ...this.calls },
      clients: this.clients.size,
    });
  }

  getDailySalt(): Promise<string> {
    return Promise.resolve(this.salt);
  }
}
