export type McpUsageDay = { calls: Record<string, number>; clients: number };

export interface IMcpUsageStore {
  /** `field` is `tool|chainId|label|outcome`. */
  incrementCall(date: string, field: string): Promise<void>;
  addClient(date: string, hash: string): Promise<void>;
  getDay(date: string): Promise<McpUsageDay>;
  getDailySalt(date: string): Promise<string>;
}

export const McpUsageStore = Symbol('McpUsageStore');
