import { SponsoredChainsConfigurationSchema } from '@/modules/relay/domain/entities/sponsored-chains.configuration';

describe('SponsoredChainsConfigurationSchema', () => {
  const entry = {
    perSafePerDay: 100,
    perOwnerCreationsPerDay: 20,
    maxGasLimit: 1_500_000,
    dailyBudgetGwei: 100_000_000,
    maxGasPriceWei: '500000000',
  };

  it('accepts a valid per-chain map', () => {
    expect(
      SponsoredChainsConfigurationSchema.parse({ '84532': entry }),
    ).toEqual({ '84532': entry });
  });

  it('accepts an empty map', () => {
    expect(SponsoredChainsConfigurationSchema.parse({})).toEqual({});
  });

  it('allows perOwnerCreationsPerDay 0 (creation not sponsored)', () => {
    expect(() =>
      SponsoredChainsConfigurationSchema.parse({
        '1': { ...entry, perOwnerCreationsPerDay: 0 },
      }),
    ).not.toThrow();
  });

  it.each([
    ['perSafePerDay', 0],
    ['perSafePerDay', 1.5],
    ['maxGasLimit', 0],
    ['dailyBudgetGwei', -1],
    ['dailyBudgetGwei', Number.MAX_SAFE_INTEGER + 1],
    ['maxGasPriceWei', '0'],
    ['maxGasPriceWei', '1e9'],
    ['perOwnerCreationsPerDay', -1],
  ])('rejects %s = %p', (field, value) => {
    expect(() =>
      SponsoredChainsConfigurationSchema.parse({
        '84532': { ...entry, [field]: value },
      }),
    ).toThrow();
  });

  it('rejects a non-numeric chain id', () => {
    expect(() =>
      SponsoredChainsConfigurationSchema.parse({ base: entry }),
    ).toThrow();
  });
});
