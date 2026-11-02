import { getAddress } from 'viem';
import { faker } from '@faker-js/faker';
import { callTool } from '@/modules/mcp/tools/__tests__/call-tool';
import { proposersTools } from '@/modules/mcp/tools/proposers.tools';
import type { IDelegatesV2Repository } from '@/modules/delegate/domain/v2/delegates.v2.repository.interface';

describe('list_proposers', () => {
  const repository = { getDelegates: jest.fn() };
  const tools = proposersTools(repository as unknown as IDelegatesV2Repository);
  const safeAddress = getAddress(faker.finance.ethereumAddress());

  it('returns delegate, delegator, label and states it lists multisig-scoped delegates', async () => {
    const delegate = getAddress(faker.finance.ethereumAddress());
    const delegator = getAddress(faker.finance.ethereumAddress());
    repository.getDelegates.mockResolvedValue({
      count: 1,
      next: null,
      previous: null,
      results: [{ safe: safeAddress, delegate, delegator, label: 'bot' }],
    });

    const { payload } = await callTool(tools, 'list_proposers', {
      chainId: '1',
      safeAddress,
    });

    expect(repository.getDelegates).toHaveBeenCalledWith({
      chainId: '1',
      safeAddress,
      limit: 20,
    });
    expect(payload.results).toEqual([{ delegate, delegator, label: 'bot' }]);
    expect(payload.scope).toMatch(/this multisig account only/);
    expect(payload.truncated).toBe(false);
  });

  it('says when more delegates exist', async () => {
    repository.getDelegates.mockResolvedValue({
      count: 30,
      next: 'https://tx.test/?offset=20',
      previous: null,
      results: [],
    });

    const { payload } = await callTool(tools, 'list_proposers', {
      chainId: '1',
      safeAddress,
    });

    expect(payload.truncated).toBe(true);
  });
});
