import { RelayRepository } from '@/modules/relay/domain/relay.repository';
import type { IRelayManager } from '@/modules/relay/domain/interfaces/relay-manager.interface';
import type { IRelayApi } from '@/domain/interfaces/relay-api.interface';
import type { GasTokenFeeService } from '@/modules/relay/domain/gas-token-fee.service';
import type { GasTokenRelayer } from '@/modules/relay/domain/relayers/gas-token.relayer';
import type { RelayScreeningService } from '@/modules/relay/domain/sanctions/relay-screening.service';

describe('RelayRepository gas token capability', () => {
  it('returns an empty capability when GAS_TOKEN is disabled', async () => {
    const relayManager = {} as IRelayManager;
    const relayApi = {} as IRelayApi;
    const gasTokenRelayer = {} as GasTokenRelayer;
    const feeService = {
      isEnabled: jest.fn().mockResolvedValue(false),
      getConfiguration: jest.fn(),
    } as unknown as GasTokenFeeService;
    const relayScreeningService = { screen: jest.fn() };
    const repository = new RelayRepository(
      relayManager,
      relayApi,
      gasTokenRelayer,
      feeService,
      relayScreeningService as unknown as RelayScreeningService,
    );

    await expect(repository.getGasTokenConfiguration('1')).resolves.toEqual({
      gasTokens: [],
      refundReceiver: null,
    });
    expect(feeService.getConfiguration).not.toHaveBeenCalled();
  });
});
