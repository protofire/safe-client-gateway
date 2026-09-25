describe('configuration', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...OLD_ENV };
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  it('treats a blank SANCTIONS_MAX_STALENESS_HOURS as unset (defaults to 48)', async () => {
    process.env.SANCTIONS_MAX_STALENESS_HOURS = '';
    const configuration = (await import('@/config/entities/configuration'))
      .default;
    expect(configuration().relay.sanctions.maxStalenessHours).toBe(48);
  });

  it('parses a non-blank SANCTIONS_MAX_STALENESS_HOURS', async () => {
    process.env.SANCTIONS_MAX_STALENESS_HOURS = '12';
    const configuration = (await import('@/config/entities/configuration'))
      .default;
    expect(configuration().relay.sanctions.maxStalenessHours).toBe(12);
  });
});
