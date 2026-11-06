import type { IConfigurationService } from '@/config/configuration.service.interface';
import { getTxAuthHeaders } from '@/datasources/network/auth/tx-auth-headers.helper';

describe('getTxAuthHeaders', () => {
  let mockConfigService: jest.Mocked<IConfigurationService>;

  beforeEach(() => {
    jest.resetAllMocks();
    mockConfigService = {
      getOrThrow: jest.fn(),
      get: jest.fn(),
    } as jest.Mocked<IConfigurationService>;
  });

  it.each([
    { isDevelopment: true, useVpcUrl: false },
    { isDevelopment: true, useVpcUrl: true },
    { isDevelopment: false, useVpcUrl: false },
    { isDevelopment: false, useVpcUrl: true },
  ])(
    'should return Authorization header when the API key is set (isDevelopment: $isDevelopment, useVpcUrl: $useVpcUrl)',
    ({ isDevelopment, useVpcUrl }) => {
      const apiKey = 'test-api-key-123';
      mockConfigService.getOrThrow.mockImplementation((key: string) => {
        if (key === 'application.isDevelopment') return isDevelopment;
        if (key === 'safeTransaction.useVpcUrl') return useVpcUrl;
        throw new Error(`Unexpected key: ${key}`);
      });
      mockConfigService.get.mockReturnValue(apiKey);

      const result = getTxAuthHeaders(mockConfigService);

      expect(result).toEqual({
        Authorization: `Bearer ${apiKey}`,
      });
      expect(mockConfigService.get).toHaveBeenCalledWith(
        'safeTransaction.apiKey',
      );
    },
  );

  it.each([
    { description: 'API key is undefined', apiKey: undefined },
    { description: 'API key is empty string', apiKey: '' },
  ])('should return undefined when $description', ({ apiKey }) => {
    mockConfigService.get.mockReturnValue(apiKey);

    const result = getTxAuthHeaders(mockConfigService);

    expect(result).toBeUndefined();
  });
});
