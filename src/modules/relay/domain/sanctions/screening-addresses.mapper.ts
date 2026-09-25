import { Inject, Injectable } from '@nestjs/common';
import { getAddress, type Address, type Hex } from 'viem';
import { SafeDecoder } from '@/modules/contracts/domain/decoders/safe-decoder.helper';
import { MultiSendDecoder } from '@/modules/contracts/domain/decoders/multi-send-decoder.helper';
import { Erc20Decoder } from '@/modules/relay/domain/contracts/decoders/erc-20-decoder.helper';
import { ProxyFactoryDecoder } from '@/modules/relay/domain/contracts/decoders/proxy-factory-decoder.helper';
import { LimitAddressesMapper } from '@/modules/relay/domain/limit-addresses.mapper';
import { NestedRefundError } from '@/modules/relay/domain/errors/nested-refund.error';
import { ISafeRepository } from '@/modules/safe/domain/safe.repository.interface';

export type ScreenedAddress = {
  address: Address;
  role: 'safe' | 'owner' | 'to' | 'recipient';
};

@Injectable()
export class ScreeningAddressesMapper {
  constructor(
    private readonly limitAddressesMapper: LimitAddressesMapper,
    @Inject(ISafeRepository) private readonly safeRepository: ISafeRepository,
    private readonly safeDecoder: SafeDecoder,
    private readonly erc20Decoder: Erc20Decoder,
    private readonly multiSendDecoder: MultiSendDecoder,
    private readonly proxyFactoryDecoder: ProxyFactoryDecoder,
  ) {}

  async map(args: {
    version: string;
    chainId: string;
    to: Address;
    data: Hex;
    isSafePays: boolean;
  }): Promise<Array<ScreenedAddress>> {
    const screened: Array<ScreenedAddress> = [];

    if (this.isCreateProxy(args.data)) {
      // Safe creation: getLimitAddresses returns the owners of the Safe to be created
      const owners = await this.limitAddressesMapper.getLimitAddresses(args);
      owners.forEach((owner) =>
        screened.push({ address: owner, role: 'owner' }),
      );
      return screened;
    }

    // Safe-pays must not go through daily-limit validity rules (they reject e.g. transfers to self)
    const safes = args.isSafePays
      ? [args.to]
      : await this.limitAddressesMapper.getLimitAddresses(args);
    for (const safe of safes) {
      // No catch: screening without owners would fail open
      const { owners } = await this.safeRepository.getSafe({
        chainId: args.chainId,
        address: safe,
      });
      screened.push({ address: safe, role: 'safe' });
      owners.forEach((owner) =>
        screened.push({ address: owner, role: 'owner' }),
      );
    }

    this.walk(args.data, 0, screened);
    return screened;
  }

  private walk(
    data: Hex,
    depth: number,
    screened: Array<ScreenedAddress>,
  ): void {
    const safeCall = this.tryDecodeSafe(data);
    if (safeCall?.functionName === 'execTransaction') {
      const [to, , innerData, , , , gasPrice] = safeCall.args;
      if (depth > 0 && gasPrice > BigInt(0)) {
        throw new NestedRefundError();
      }
      screened.push({ address: to, role: 'to' });
      this.walk(innerData, depth + 1, screened);
      return;
    }
    if (safeCall?.functionName === 'addOwnerWithThreshold') {
      screened.push({ address: safeCall.args[0], role: 'recipient' });
      return;
    }
    if (safeCall?.functionName === 'swapOwner') {
      screened.push({ address: safeCall.args[2], role: 'recipient' });
      return;
    }

    if (this.multiSendDecoder.helpers.isMultiSend(data)) {
      for (const tx of this.multiSendDecoder.mapMultiSendTransactions(data)) {
        screened.push({ address: getAddress(tx.to), role: 'to' });
        this.walk(tx.data, depth + 1, screened);
      }
      return;
    }

    const erc20Call = this.tryDecodeErc20(data);
    if (
      erc20Call?.functionName === 'transfer' ||
      erc20Call?.functionName === 'approve'
    ) {
      screened.push({ address: erc20Call.args[0], role: 'recipient' });
    } else if (erc20Call?.functionName === 'transferFrom') {
      screened.push(
        { address: erc20Call.args[0], role: 'recipient' },
        { address: erc20Call.args[1], role: 'recipient' },
      );
    }
    // ponytail: arbitrary contract calls (swaps, bridges) are screened by `to` only; decode more targets when a real case appears
  }

  private isCreateProxy(data: Hex): boolean {
    return this.tryDecodeProxyFactory(data) !== null;
  }

  private tryDecodeSafe(
    data: Hex,
  ): ReturnType<SafeDecoder['decodeFunctionData']> | null {
    try {
      return this.safeDecoder.decodeFunctionData({ data });
    } catch {
      return null;
    }
  }

  private tryDecodeErc20(
    data: Hex,
  ): ReturnType<Erc20Decoder['decodeFunctionData']> | null {
    try {
      return this.erc20Decoder.decodeFunctionData({ data });
    } catch {
      return null;
    }
  }

  private tryDecodeProxyFactory(
    data: Hex,
  ): ReturnType<ProxyFactoryDecoder['decodeFunctionData']> | null {
    try {
      return this.proxyFactoryDecoder.decodeFunctionData({ data });
    } catch {
      return null;
    }
  }
}
