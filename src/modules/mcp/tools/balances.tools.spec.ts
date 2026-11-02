import { getAddress } from 'viem';
import { faker } from '@faker-js/faker';
import { balancesTools } from '@/modules/mcp/tools/balances.tools';
import { callTool } from '@/modules/mcp/tools/__tests__/call-tool';

describe('get_balances', () => {
  const service = { getBalances: jest.fn() };
  const tools = balancesTools(service);
  const args = {
    chainId: '1',
    safeAddress: getAddress(faker.finance.ethereumAddress()),
  };
  const item = (fiat: number): object => ({
    balance: '1',
    fiatBalance: String(fiat),
    fiatConversion: '1',
    fiatBalance24hChange: null,
    tokenInfo: {
      type: 'ERC20',
      address: getAddress(faker.finance.ethereumAddress()),
      decimals: 18,
      logoUri: 'https://logo.test/a.png',
      name: `T${fiat}`,
      symbol: `T${fiat}`,
    },
  });

  beforeEach(() => jest.resetAllMocks());

  it('returns top 50 by fiat value', async () => {
    const items = Array.from({ length: 60 }, (_, i) => item(i));
    service.getBalances.mockResolvedValue({ fiatTotal: '1770', items });

    const { payload } = await callTool(tools, 'get_balances', args);

    expect(service.getBalances).toHaveBeenCalledWith({
      ...args,
      fiatCode: 'USD',
      trusted: true,
      excludeSpam: true,
    });
    expect(payload.results).toHaveLength(50);
    expect(payload.results[0].fiatBalance).toBe('59');
    expect(payload.results[49].fiatBalance).toBe('10');
    expect(payload).toMatchObject({ truncated: true, totalCount: 60 });
  });

  it('is not truncated at 50 items', async () => {
    service.getBalances.mockResolvedValue({
      fiatTotal: '0',
      items: Array.from({ length: 50 }, (_, i) => item(i)),
    });

    const { payload } = await callTool(tools, 'get_balances', args);

    expect(payload.truncated).toBe(false);
  });
});
