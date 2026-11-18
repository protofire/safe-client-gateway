import { DataSourceError } from '@/domain/errors/data-source.error';
import { tokenMeta } from '@/modules/org/common/token-meta';

const TOKEN = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';

function deps(
  token: () => Promise<unknown>,
  native = { decimals: 18, symbol: 'ETH' },
): Parameters<typeof tokenMeta>[0] {
  return {
    chains: {
      getChain: jest.fn().mockResolvedValue({ nativeCurrency: native }),
    },
    transactionApis: {
      getApi: jest.fn().mockResolvedValue({ getToken: jest.fn(token) }),
    },
  } as unknown as Parameters<typeof tokenMeta>[0];
}

describe('tokenMeta', () => {
  it('reads native metadata from the chain config', async () => {
    await expect(
      tokenMeta(
        deps(() => Promise.reject(new Error('unused'))),
        '1',
        'native',
      ),
    ).resolves.toEqual({ decimals: 18, symbol: 'ETH' });
  });

  it('reads ERC20 decimals and symbol from the raw tx-service token', async () => {
    const d = deps(() =>
      Promise.resolve({ type: 'ERC20', symbol: 'USDC', decimals: 6 }),
    );
    await expect(tokenMeta(d, '1', TOKEN)).resolves.toEqual({
      decimals: 6,
      symbol: 'USDC',
    });
  });

  it('accepts 0 decimals', async () => {
    const d = deps(() =>
      Promise.resolve({ type: 'ERC20', symbol: 'Z', decimals: 0 }),
    );
    await expect(tokenMeta(d, '1', TOKEN)).resolves.toEqual({
      decimals: 0,
      symbol: 'Z',
    });
  });

  it('answers not_erc20, decimals_unknown and unknown', async () => {
    const of = (v: unknown): Parameters<typeof tokenMeta>[0] =>
      deps(() => Promise.resolve(v));
    await expect(
      tokenMeta(of({ type: 'ERC721', symbol: 'N' }), '1', TOKEN),
    ).resolves.toBe('not_erc20');
    await expect(
      tokenMeta(of({ type: 'ERC20', symbol: 'X' }), '1', TOKEN),
    ).resolves.toBe('decimals_unknown');
    await expect(
      tokenMeta(of({ type: 'ERC20', symbol: 'X', decimals: null }), '1', TOKEN),
    ).resolves.toBe('decimals_unknown');
    await expect(
      tokenMeta(of({ type: 'ERC20', symbol: 'X', decimals: 256 }), '1', TOKEN),
    ).resolves.toBe('decimals_unknown');
    await expect(
      tokenMeta(
        deps(() => Promise.reject(new DataSourceError('Not found', 404))),
        '1',
        TOKEN,
      ),
    ).resolves.toBe('unknown');
  });

  it('rejects native decimals out of range as decimals_unknown', async () => {
    await expect(
      tokenMeta(
        deps(() => Promise.reject(new Error('unused')), {
          decimals: 300,
          symbol: 'X',
        }),
        '1',
        'native',
      ),
    ).resolves.toBe('decimals_unknown');
  });

  it('rethrows other read errors', async () => {
    await expect(
      tokenMeta(
        deps(() => Promise.reject(new DataSourceError('down', 503))),
        '1',
        TOKEN,
      ),
    ).rejects.toThrow('down');
  });

  it('strips control and format characters from the symbol and caps it at 32', async () => {
    const d = deps(() =>
      Promise.resolve({
        type: 'ERC20',
        symbol: `US‮DC\u0000${'x'.repeat(40)}`,
        decimals: 6,
      }),
    );
    await expect(tokenMeta(d, '1', TOKEN)).resolves.toEqual({
      decimals: 6,
      symbol: `USDC${'x'.repeat(28)}`,
    });
  });
});
