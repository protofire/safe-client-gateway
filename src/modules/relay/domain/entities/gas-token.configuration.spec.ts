import { zeroAddress } from 'viem';
import { RelayChainSchema } from '@/modules/relay/domain/entities/gas-token.configuration';
import { relayChainBuilder } from '@/modules/relay/domain/entities/__tests__/relay-chain.builder';
import contract from '@/modules/relay/domain/entities/__tests__/relay-chain-84532.contract.json';

describe('RelayChainSchema', () => {
  it('parses the config-service contract', () => {
    expect(RelayChainSchema.parse(contract)).toEqual({
      relayerId: 'base-sepolia',
      nativeUsdPrice: 2500,
      refundReceiver: '0x798D0d04E1c52020d298b6246D9A87ceb4C08b36',
      payFromSafeDailyBudgetWei: null,
      sponsoringDailyBudgetWei: '100000000000000000',
      sponsoringPerSafePerDay: 100,
      sponsoringPerOwnerCreationsPerDay: 20,
      sponsoringMaxGasLimit: 1_500_000,
      tokens: [
        {
          address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          symbol: 'USDC',
          decimals: 6,
          usdPrice: 1,
        },
      ],
    });
  });

  it('turns a null token price into undefined (priced by the market)', () => {
    const parsed = RelayChainSchema.parse({
      ...contract,
      tokens: [{ ...contract.tokens[0], usdPrice: null }],
    });
    expect(parsed.tokens[0].usdPrice).toBeUndefined();
  });

  it('accepts null optional fields (no budget, no price, no receiver)', () => {
    expect(() =>
      RelayChainSchema.parse({
        ...contract,
        nativeUsdPrice: null,
        refundReceiver: null,
        sponsoringDailyBudgetWei: null,
        sponsoringPerSafePerDay: null,
        sponsoringPerOwnerCreationsPerDay: null,
        sponsoringMaxGasLimit: null,
      }),
    ).not.toThrow();
  });

  it('checksums a lowercase token address', () => {
    const parsed = RelayChainSchema.parse({
      ...contract,
      tokens: [
        {
          ...contract.tokens[0],
          address: contract.tokens[0].address.toLowerCase(),
        },
      ],
    });
    expect(parsed.tokens[0].address).toBe(
      '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    );
  });

  it.each([
    ['an empty relayer id', { relayerId: '' }],
    ['a relayer id with a dot', { relayerId: 'base.sepolia' }],
    ['a relayer id with a space', { relayerId: 'a b' }],
    ['a relayer id with a colon', { relayerId: 'a:b' }],
    ['a 65-char relayer id', { relayerId: 'a'.repeat(65) }],
    ['a zero refund receiver', { refundReceiver: zeroAddress }],
    ['a zero budget', { sponsoringDailyBudgetWei: '0' }],
    ['a non-integer budget', { payFromSafeDailyBudgetWei: '1.5' }],
    ['a zero native price', { nativeUsdPrice: '0.00000000' }],
    ['a zero per-Safe limit', { sponsoringPerSafePerDay: 0 }],
  ])('rejects %s', (_, override) => {
    expect(() =>
      RelayChainSchema.parse({ ...contract, ...override }),
    ).toThrow();
  });

  it('rejects a duplicate token address regardless of case', () => {
    const token = contract.tokens[0];
    expect(() =>
      RelayChainSchema.parse({
        ...contract,
        tokens: [token, { ...token, address: token.address.toLowerCase() }],
      }),
    ).toThrow('duplicate token address');
  });

  it('rejects a blank token symbol', () => {
    expect(() =>
      RelayChainSchema.parse({
        ...contract,
        tokens: [{ ...contract.tokens[0], symbol: '   ' }],
      }),
    ).toThrow();
  });

  it('accepts what the builder builds', () => {
    const relayChain = relayChainBuilder().build();
    expect(RelayChainSchema.parse(relayChain)).toEqual(relayChain);
  });
});
