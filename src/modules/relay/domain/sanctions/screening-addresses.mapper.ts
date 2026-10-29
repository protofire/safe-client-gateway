import { Inject, Injectable } from '@nestjs/common';
import { getAddress, zeroAddress, type Address, type Hex } from 'viem';
import { SafeDecoder } from '@/modules/contracts/domain/decoders/safe-decoder.helper';
import { MultiSendDecoder } from '@/modules/contracts/domain/decoders/multi-send-decoder.helper';
import { Erc20Decoder } from '@/modules/relay/domain/contracts/decoders/erc-20-decoder.helper';
import { ProxyFactoryDecoder } from '@/modules/relay/domain/contracts/decoders/proxy-factory-decoder.helper';
import { DelayModifierDecoder } from '@/modules/alerts/domain/contracts/decoders/delay-modifier-decoder.helper';
import { LimitAddressesMapper } from '@/modules/relay/domain/limit-addresses.mapper';
import { NestedRefundError } from '@/modules/relay/domain/errors/nested-refund.error';
import { ISafeRepository } from '@/modules/safe/domain/safe.repository.interface';

export type ScreenedAddress = {
  address: Address;
  role: 'safe' | 'owner' | 'to' | 'recipient';
};

/**
 * Value moved by the transaction, for the rejected-transaction report.
 * token null = native coin; amount in raw base units (decimals come from `token`);
 * from null = not known up front (the Safe a creation deploys).
 */
export type ScreenedTransfer = {
  token: Address | null;
  from: Address | null;
  to: Address;
  amount: string;
};

/** Who calls (`sender`) which address (`target`), how (0 CALL, 1 DELEGATECALL), with the calldata being walked. */
type CallContext = {
  target: Address;
  sender: Address;
  operation: number;
  transfers: Array<ScreenedTransfer>;
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
    private readonly delayModifierDecoder: DelayModifierDecoder,
  ) {}

  async map(args: {
    version: string;
    chainId: string;
    to: Address;
    data: Hex;
    isSafePays: boolean;
  }): Promise<{
    screened: Array<ScreenedAddress>;
    transfers: Array<ScreenedTransfer>;
  }> {
    const screened: Array<ScreenedAddress> = [];
    const transfers: Array<ScreenedTransfer> = [];

    if (this.isCreateProxy(args.data)) {
      // Safe creation: getLimitAddresses returns the owners of the Safe to be created
      const owners = await this.limitAddressesMapper.getLimitAddresses(args);
      owners.forEach((owner) =>
        screened.push({ address: owner, role: 'owner' }),
      );
      this.screenCreateProxySetup(args.data, screened, transfers);
      return { screened, transfers };
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

    // ponytail: a top-level call that is not execTransaction is attributed to `to` as sender; relays are execTransaction in practice
    this.walk(args.data, 0, screened, {
      target: args.to,
      sender: args.to,
      operation: 0,
      transfers,
    });
    return { screened, transfers };
  }

  /**
   * Runs the nested-refund guard alone, independently of sanctions screening
   * being enabled. A MultiSend-wrapped execTransaction with gasPrice > 0 must
   * never reach a relayer, screening on or off.
   */
  assertNoNestedRefund(data: Hex): void {
    this.walk(data, 0, null, null);
  }

  private walk(
    data: Hex,
    depth: number,
    screened: Array<ScreenedAddress> | null,
    ctx: CallContext | null,
  ): void {
    const isMultiSend = this.multiSendDecoder.helpers.isMultiSend(data);
    // Code run by DELEGATECALL (other than MultiSend) acts as the Safe in ways we do not
    // model: record no transfers or value for anything nested; addresses are still screened
    if (ctx?.operation === 1 && !isMultiSend) {
      ctx = null;
    }
    const safeCall = this.tryDecodeSafe(data);
    if (safeCall?.functionName === 'execTransaction') {
      const [to, value, innerData, operation, , , gasPrice] = safeCall.args;
      if (depth > 0 && gasPrice > BigInt(0)) {
        throw new NestedRefundError();
      }
      screened?.push({ address: to, role: 'to' });
      // The Safe (ctx.target) makes the inner call
      this.walk(
        innerData,
        depth + 1,
        screened,
        this.call(ctx, ctx?.target, to, operation, value),
      );
      return;
    }
    if (safeCall?.functionName === 'execTransactionFromModule') {
      const [to, value, innerData, operation] = safeCall.args;
      screened?.push({ address: to, role: 'to' });
      this.walk(
        innerData,
        depth + 1,
        screened,
        this.call(ctx, ctx?.target, to, operation, value),
      );
      return;
    }
    if (safeCall?.functionName === 'addOwnerWithThreshold') {
      screened?.push({ address: safeCall.args[0], role: 'recipient' });
      return;
    }
    if (safeCall?.functionName === 'swapOwner') {
      screened?.push({ address: safeCall.args[2], role: 'recipient' });
      return;
    }

    const delayCall = this.tryDecodeDelayModifier(data);
    if (
      delayCall?.functionName === 'execTransactionFromModule' ||
      delayCall?.functionName === 'executeNextTx'
    ) {
      const [to, value, innerData, operation] = delayCall.args;
      screened?.push({ address: to, role: 'to' });
      // ponytail: the modifier's avatar Safe makes this call but is recorded as the modifier; resolve the avatar if reports need it
      this.walk(
        innerData,
        depth + 1,
        screened,
        this.call(ctx, ctx?.target, to, operation, value),
      );
      return;
    }

    if (isMultiSend) {
      for (const tx of this.multiSendDecoder.mapMultiSendTransactions(data)) {
        const to = getAddress(tx.to);
        screened?.push({ address: to, role: 'to' });
        // DELEGATECALLed (the norm), sub-calls come from the Safe; CALLed, from the MultiSend contract
        const from = ctx?.operation === 1 ? ctx.sender : ctx?.target;
        this.walk(
          tx.data,
          depth + 1,
          screened,
          this.call(ctx, from, to, tx.operation, tx.value),
        );
      }
      return;
    }

    const erc20Call = this.tryDecodeErc20(data);
    if (
      erc20Call?.functionName === 'transfer' ||
      erc20Call?.functionName === 'approve'
    ) {
      screened?.push({ address: erc20Call.args[0], role: 'recipient' });
      if (erc20Call.functionName === 'transfer') {
        ctx?.transfers.push({
          token: ctx.target,
          from: ctx.sender,
          to: erc20Call.args[0],
          amount: erc20Call.args[1].toString(),
        });
      }
    } else if (erc20Call?.functionName === 'transferFrom') {
      screened?.push(
        { address: erc20Call.args[0], role: 'recipient' },
        { address: erc20Call.args[1], role: 'recipient' },
      );
      ctx?.transfers.push({
        token: ctx.target,
        from: erc20Call.args[0],
        to: erc20Call.args[1],
        amount: erc20Call.args[2].toString(),
      });
    }
    // ponytail: arbitrary contract calls (swaps, bridges) are screened by `to` only; decode more targets when a real case appears
  }

  /**
   * Records the native value of a call (a delegatecall, operation 1, moves none)
   * and returns the context its calldata runs in.
   */
  private call(
    ctx: CallContext | null,
    from: Address | undefined,
    to: Address,
    operation: number,
    value: bigint,
  ): CallContext | null {
    if (!ctx || !from) {
      return null;
    }
    if (operation === 0 && value > BigInt(0)) {
      ctx.transfers.push({ token: null, from, to, amount: value.toString() });
    }
    return { target: to, sender: from, operation, transfers: ctx.transfers };
  }

  /**
   * For a Safe creation relay, screens the setup() delegatecall target (`to`)
   * and payment receiver alongside the owners already collected, and records
   * the setup() payment the new Safe makes.
   */
  private screenCreateProxySetup(
    data: Hex,
    screened: Array<ScreenedAddress>,
    transfers: Array<ScreenedTransfer>,
  ): void {
    const proxyCall = this.tryDecodeProxyFactory(data);
    if (proxyCall?.functionName !== 'createProxyWithNonce') {
      return;
    }
    const setupCall = this.tryDecodeSafe(proxyCall.args[1]);
    if (setupCall?.functionName !== 'setup') {
      return;
    }
    const [, , to, , , paymentToken, payment, paymentReceiver] = setupCall.args;
    if (payment > BigInt(0)) {
      // ponytail: from (the CREATE2 Safe address) is not predicted; compute it if reports need it. A zero receiver means tx.origin (the relayer)
      transfers.push({
        token: paymentToken === zeroAddress ? null : paymentToken,
        from: null,
        to: paymentReceiver,
        amount: payment.toString(),
      });
    }
    if (to !== zeroAddress) {
      screened.push({ address: to, role: 'to' });
    }
    if (paymentReceiver !== zeroAddress) {
      screened.push({ address: paymentReceiver, role: 'recipient' });
    }
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

  private tryDecodeDelayModifier(
    data: Hex,
  ): ReturnType<DelayModifierDecoder['decodeFunctionData']> | null {
    try {
      return this.delayModifierDecoder.decodeFunctionData({ data });
    } catch {
      return null;
    }
  }
}
