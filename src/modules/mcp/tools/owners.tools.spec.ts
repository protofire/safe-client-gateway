import { getAddress } from 'viem';
import { faker } from '@faker-js/faker';
import { DataSourceError } from '@/domain/errors/data-source.error';
import { callTool } from '@/modules/mcp/tools/__tests__/call-tool';
import { McpFanoutLimit } from '@/modules/mcp/mcp-fanout-limit';
import type { ClsService } from 'nestjs-cls';
import type { ICacheService } from '@/datasources/cache/cache.service.interface';
import { MAX_MULTISIGS, ownersTools } from '@/modules/mcp/tools/owners.tools';
import type { McpTool } from '@/modules/mcp/tools/define-tool';
import type { ISafeRepository } from '@/modules/safe/domain/safe.repository.interface';

describe('find_safes_by_owner', () => {
  const repository = {
    getAllSafesByOwnerV2: jest.fn(),
    getSafesByOwnerV2: jest.fn(),
  };
  const fanoutLimit = { check: jest.fn() };
  const tools = ownersTools(
    repository as unknown as ISafeRepository,
    fanoutLimit,
  );
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

  it('names a chain the config service does not know unknown_chain', async () => {
    repository.getSafesByOwnerV2.mockImplementation(({ chainId }) =>
      chainId === '1'
        ? Promise.reject(new DataSourceError('Not found', 404))
        : Promise.reject(new DataSourceError('Bad gateway', 502)),
    );

    const { payload } = await callTool(tools, 'find_safes_by_owner', {
      ownerAddress,
      chainIds: ['1', '10'],
    });

    expect(payload.coverage).toEqual([
      { chainId: '1', error: 'unknown_chain' },
      { chainId: '10', error: 'unavailable' },
    ]);
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

  describe('fan-out limit', () => {
    function limited(): Array<McpTool> {
      const counts = new Map<string, number>();
      const cache = {
        increment: jest.fn((key: string) => {
          counts.set(key, (counts.get(key) ?? 0) + 1);
          return Promise.resolve(counts.get(key));
        }),
      };
      const cls = { get: jest.fn().mockReturnValue('203.0.113.5') };
      const limit = new McpFanoutLimit(
        cache as unknown as ICacheService,
        cls as unknown as ClsService,
      );
      return ownersTools(repository as unknown as ISafeRepository, limit);
    }

    it('the 6th call without chainIds in a minute returns RATE_LIMITED', async () => {
      repository.getAllSafesByOwnerV2.mockResolvedValue({});
      const limitedTools = limited();

      for (let i = 0; i < 5; i++) {
        const { isError } = await callTool(
          limitedTools,
          'find_safes_by_owner',
          {
            ownerAddress,
          },
        );
        expect(isError).toBeUndefined();
      }
      const { isError, payload } = await callTool(
        limitedTools,
        'find_safes_by_owner',
        { ownerAddress },
      );

      expect(isError).toBe(true);
      expect(payload.code).toBe('RATE_LIMITED');
      expect(repository.getAllSafesByOwnerV2).toHaveBeenCalledTimes(5);
    });

    it('calls with chainIds do not count', async () => {
      repository.getSafesByOwnerV2.mockResolvedValue({ safes: [] });
      repository.getAllSafesByOwnerV2.mockResolvedValue({});
      const limitedTools = limited();

      for (let i = 0; i < 10; i++) {
        await callTool(limitedTools, 'find_safes_by_owner', {
          ownerAddress,
          chainIds: ['1'],
        });
      }
      const { isError } = await callTool(limitedTools, 'find_safes_by_owner', {
        ownerAddress,
      });

      expect(isError).toBeUndefined();
    });
  });
});
