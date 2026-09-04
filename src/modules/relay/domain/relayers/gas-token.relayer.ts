import { Inject, Injectable } from '@nestjs/common';
import { isAddressEqual, type Address, type Hex } from 'viem';
import { IRelayer } from '@/modules/relay/domain/interfaces/relayer.interface';
import { IConfigurationService } from '@/config/configuration.service.interface';
import { IRelayApi } from '@/domain/interfaces/relay-api.interface';
import { ILoggingService, LoggingService } from '@/logging/logging.interface';
import { ISafeRepository } from '@/modules/safe/domain/safe.repository.interface';
import { SafeDecoder } from '@/modules/contracts/domain/decoders/safe-decoder.helper';
import { GasTokenFeeService } from '@/modules/relay/domain/gas-token-fee.service';
import {
  Relay,
  RelaySchema,
} from '@/modules/relay/domain/entities/relay.entity';
import type { GasTokenConfiguration } from '@/modules/relay/domain/entities/gas-token.configuration';
import { GasTokenRelayError } from '@/modules/relay/domain/errors/gas-token-relay.error';
import { UnofficialMasterCopyError } from '@/modules/relay/domain/errors/unofficial-master-copy.error';

export type SafePaysFee = {
  baseGas: bigint;
  gasPrice: bigint;
  gasToken: Address;
  refundReceiver: Address;
};

/**
 * Relays transactions whose Safe refunds the executor in a token ("Safe pays").
 * No daily quota: the Safe covers the cost. Instead the calldata must name our
 * refund receiver and an allowlisted token, simulate cleanly and still cover today's gas.
 */
@Injectable()
export class GasTokenRelayer implements IRelayer {
  private readonly gasLimitBuffer: bigint;

  constructor(
    @Inject(LoggingService) private readonly loggingService: ILoggingService,
    @Inject(IConfigurationService) configurationService: IConfigurationService,
    private readonly safeDecoder: SafeDecoder,
    @Inject(ISafeRepository) private readonly safeRepository: ISafeRepository,
    private readonly feeService: GasTokenFeeService,
    @Inject(IRelayApi) private readonly relayApi: IRelayApi,
  ) {
    this.gasLimitBuffer = BigInt(
      configurationService.getOrThrow<GasTokenConfiguration>('relay.gasToken')
        .gasLimitBuffer,
    );
  }

  /** Fee fields of a direct `execTransaction` in which the Safe pays the executor, else null. */
  getSafePaysFee(data: Hex): SafePaysFee | null {
    const decoded = this.decode(data);
    if (!decoded || decoded.functionName !== 'execTransaction') {
      return null;
    }
    const [, , , , , baseGas, gasPrice, gasToken, refundReceiver] =
      decoded.args;
    if (gasPrice === BigInt(0)) {
      return null;
    }
    return { baseGas, gasPrice, gasToken, refundReceiver };
  }

  canRelay(): Promise<{
    result: boolean;
    currentCount: number;
    limit: number;
  }> {
    return Promise.resolve({
      result: true,
      currentCount: 0,
      limit: Number.MAX_SAFE_INTEGER,
    });
  }

  getRelaysRemaining(): Promise<{ remaining: number; limit: number }> {
    return Promise.resolve({
      remaining: Number.MAX_SAFE_INTEGER,
      limit: Number.MAX_SAFE_INTEGER,
    });
  }

  async relay(args: {
    version: string;
    chainId: string;
    to: Address;
    data: Hex;
    gasLimit: bigint | null;
  }): Promise<Relay> {
    const fee = this.getSafePaysFee(args.data);
    if (!fee) {
      throw new GasTokenRelayError('Not a Safe-pays execTransaction');
    }

    const isOfficial = await this.safeRepository
      .getSafe({ chainId: args.chainId, address: args.to })
      .then(
        () => true,
        () => false,
      );
    if (!isOfficial) {
      throw new UnofficialMasterCopyError();
    }

    const refundReceiver = this.feeService.getRefundReceiver(args.chainId);
    if (!refundReceiver) {
      throw new GasTokenRelayError(
        `Paying fees from the Safe is not available on chain ${args.chainId}`,
      );
    }
    if (!isAddressEqual(refundReceiver, fee.refundReceiver)) {
      throw new GasTokenRelayError(
        'refundReceiver does not match the relayer refund address',
      );
    }

    const token = this.feeService.getAllowlistedToken(
      args.chainId,
      fee.gasToken,
    );
    if (!token) {
      throw new GasTokenRelayError(
        `${fee.gasToken} is not an accepted fee token on chain ${args.chainId}`,
      );
    }

    const gasEstimate = await this.feeService.simulate({
      chainId: args.chainId,
      safeAddress: args.to,
      data: args.data,
    });
    await this.feeService.assertRefundCovers({
      chainId: args.chainId,
      token,
      gasPrice: fee.gasPrice,
      baseGas: fee.baseGas,
      gasEstimate,
    });

    const simulatedLimit = gasEstimate + this.gasLimitBuffer;
    const gasLimit =
      args.gasLimit && args.gasLimit > simulatedLimit
        ? args.gasLimit
        : simulatedLimit;

    const relay = await this.relayApi
      .relay({
        chainId: args.chainId,
        to: args.to,
        data: args.data,
        gasLimit,
      })
      .then(RelaySchema.parse);

    this.loggingService.info(
      `Safe-pays relay ${relay.taskId} | chain: ${args.chainId} | safe: ${args.to} | gasToken: ${fee.gasToken} | gasEstimate: ${gasEstimate}`,
    );

    return relay;
  }

  private decode(
    data: Hex,
  ): ReturnType<SafeDecoder['decodeFunctionData']> | null {
    try {
      return this.safeDecoder.decodeFunctionData({ data });
    } catch {
      return null;
    }
  }
}
