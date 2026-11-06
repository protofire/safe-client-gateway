import type { IConfigurationService } from '@/config/configuration.service.interface';

/**
 * Returns Transaction Service auth headers whenever a Transaction Service API key is configured.
 *
 * @param configurationService - Configuration service used to read settings
 * @returns An object containing the `Authorization` header (`{ Authorization: `Bearer ${apiKey}` }`)
 *          when an API key is configured; otherwise `undefined`.
 */
export function getTxAuthHeaders(
  configurationService: IConfigurationService,
): Record<string, string> | undefined {
  const apiKey = configurationService.get<string | undefined>(
    'safeTransaction.apiKey',
  );

  if (!apiKey) {
    return undefined;
  }

  return {
    Authorization: `Bearer ${apiKey}`,
  };
}
