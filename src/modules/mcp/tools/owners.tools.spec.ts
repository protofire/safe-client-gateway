import { getAddress } from 'viem';
import { faker } from '@faker-js/faker';
import { callTool } from '@/modules/mcp/tools/__tests__/call-tool';
import { MAX_MULTISIGS, ownersTools } from '@/modules/mcp/tools/owners.tools';
import type { ISafeRepository } from '@/modules/safe/domain/safe.repository.interface';

describe('find_safes_by_owner', () => {
  const repository = {
    getAllSafesByOwnerV2: jest.fn(),
    getSafesByOwnerV2: jest.fn(),
  };
  const tools = ownersTools(repository as unknown as ISafeRepository);
  const ownerAddress = getAddress(faker.finance.ethereumAddress());
  const address = (): string => getAddress(faker.finance.ethereumAddress());

  beforeEach(() => jest.resetAllMocks());

  it('reports a failed chain in coverage, keeps the others', async () => {
    const safe = address();
    repository.getAllSafesByOwnerV2.mockResolvedValue({
      '1': [safe],
      '10': null,
    });

    const { payload } = await callTool(tools, 'find_safes_by_owner', {
      ownerAddress,
    });

    expect(payload).toMatchObject({
      multisigs: { '1': [safe] },
      coverage: [{ chainId: '10', error: 'unavailable' }],
      truncated: false,
    });
  });

  it('with chainIds uses getSafesByOwnerV2 per chain, a rejection lands in coverage', async () => {
    const safe = address();
    repository.getSafesByOwnerV2.mockImplementation(({ chainId }) =>
      chainId === '1'
        ? Promise.resolve({ safes: [safe] })
        : Promise.reject(new Error('boom')),
    );

    const { payload } = await callTool(tools, 'find_safes_by_owner', {
      ownerAddress,
      chainIds: ['1', '10', '1'],
    });

    expect(repository.getAllSafesByOwnerV2).not.toHaveBeenCalled();
    expect(repository.getSafesByOwnerV2).toHaveBeenCalledTimes(2);
    expect(payload).toMatchObject({
      multisigs: { '1': [safe] },
      coverage: [{ chainId: '10', error: 'unavailable' }],
    });
  });

  it('rejects 6 chainIds with INVALID_INPUT', async () => {
    const { isError, payload } = await callTool(tools, 'find_safes_by_owner', {
      ownerAddress,
      chainIds: ['1', '2', '3', '4', '5', '6'],
    });

    expect(isError).toBe(true);
    expect(payload.code).toBe('INVALID_INPUT');
    expect(repository.getSafesByOwnerV2).not.toHaveBeenCalled();
  });

  it('caps the result at 100 multisigs and says so', async () => {
    const many = (count: number): Array<string> =>
      Array.from({ length: count }, address);
    repository.getAllSafesByOwnerV2.mockResolvedValue({
      '1': many(60),
      '10': many(60),
    });

    const { payload } = await callTool(tools, 'find_safes_by_owner', {
      ownerAddress,
    });

    const total = Object.values(
      payload.multisigs as Record<string, Array<string>>,
    ).flat().length;
    expect(total).toBe(MAX_MULTISIGS);
    expect(payload.truncated).toBe(true);
  });

  it('does not flag truncated at exactly the cap', async () => {
    repository.getAllSafesByOwnerV2.mockResolvedValue({
      '1': Array.from({ length: MAX_MULTISIGS }, address),
    });

    const { payload } = await callTool(tools, 'find_safes_by_owner', {
      ownerAddress,
    });

    expect(payload.truncated).toBe(false);
  });
});
