import type { ILoggingService } from '@/logging/logging.interface';
import { McpToolEvents, type McpTool } from '@/modules/mcp/tools/define-tool';

const events = new McpToolEvents({
  error: jest.fn(),
} as unknown as ILoggingService);

export async function callTool(
  tools: Array<McpTool>,
  name: string,
  args: unknown,
): Promise<{
  isError?: boolean; // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests index into JSON
  payload: Record<string, any>;
}> {
  const tool = tools.find((candidate) => candidate.name === name)!;
  const result = await tool.call(args, events);
  const [{ text }] = result.content as Array<{ text: string }>;
  return { isError: result.isError, payload: JSON.parse(text) };
}
